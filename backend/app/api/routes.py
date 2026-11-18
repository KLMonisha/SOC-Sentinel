
import tempfile
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException

from app.services.ingestion import ingest_file, MAX_FILE_SIZE
from app.services.detection import run_detection
from app.services.correlation import correlate_alerts


router = APIRouter(prefix="/api", tags=["SOC Sentinel"])


@router.post("/analyze")
async def analyze_logs(file: UploadFile = File(...)):
    """
    Upload a CSV or JSON log file and run the complete
    SOC Sentinel analysis pipeline.
    """

    if not file.filename:
        raise HTTPException(
            status_code=400,
            detail="A filename is required."
        )

    extension = Path(file.filename).suffix.lower()
    original_filename = Path(file.filename).name

    if extension not in {".csv", ".json"}:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file format. Upload a CSV or JSON file."
        )

    content = await file.read(MAX_FILE_SIZE + 1)

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 10 MB size limit."
        )

    if not content:
        raise HTTPException(
            status_code=400,
            detail="Uploaded file is empty."
        )

    temp_path = None

    try:
        # Create a temporary file for the ingestion service.
        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=extension,
            delete=False
        ) as temp_file:
            temp_file.write(content)
            temp_path = Path(temp_file.name)

        # Stage 1: Ingest and normalize.
        ingestion_result = ingest_file(
            temp_path,
            source_name=original_filename
        )

        events = ingestion_result["events"]

        # Stage 2: Detect suspicious activity.
        alerts = run_detection(events)

        # Stage 3: Correlate alerts into incidents.
        incidents = correlate_alerts(alerts, events)

        # Stage 4: Prepare a safe API response.
        quarantined_summary = [
            {
                "row_number": item["row_number"],
                "reason": item["reason"]
            }
            for item in ingestion_result["quarantined_records"]
        ]

        return {
            "status": "success",
            "dataset": file.filename,
            "summary": {
                "total_records": ingestion_result["total_records"],
                "valid_events": ingestion_result["valid_count"],
                "quarantined_records": ingestion_result["quarantined_count"],
                "alerts_generated": len(alerts),
                "incidents_created": len(incidents)
            },
            "alerts": alerts,
            "incidents": incidents,
            "quarantined_records": quarantined_summary
        }

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error)
        )

    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()

        await file.close()
