
import tempfile
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from app.services.mitre_mapping import enrich_alerts_with_attack
from app.services.ingestion import ingest_file, MAX_FILE_SIZE
from app.services.detection import run_detection
from app.services.correlation import correlate_alerts
import json
from app.services.reporting import generate_investigation_report
from app.services.counterfactual import run_counterfactual
from app.services.assessment import (
    enrich_alerts_with_confidence,
    assess_telemetry_coverage,
)
from app.services.llm_reporting import generate_llm_narrative
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

        alerts = enrich_alerts_with_attack(alerts)
        alerts = enrich_alerts_with_confidence(alerts, events)

        coverage = assess_telemetry_coverage(events)
        # Stage 3: Correlate alerts into incidents.
        incidents = correlate_alerts(alerts, events)
        report = generate_investigation_report(
            events=events,
            alerts=alerts,
            incidents=incidents,
            telemetry_coverage=coverage,
        )
        report = generate_llm_narrative(report)
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
            "dataset": original_filename,
            "summary": {
                "total_records": ingestion_result["total_records"],
                "valid_events": ingestion_result["valid_count"],
                "quarantined_records": ingestion_result["quarantined_count"],
                "alerts_generated": len(alerts),
                "incidents_created": len(incidents)
            },
            "telemetry_coverage": coverage,
            "alerts": alerts,
            "incidents": incidents,
            "report": report,
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

@router.post("/counterfactual")
async def counterfactual_analysis(
    file: UploadFile = File(...),
    event_ids_to_exclude: str = Form(...),
    reason: str = Form(...)
):
    """
    Run a hypothetical investigation by excluding selected events.

    The original dataset is never modified.
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

    # Parse the event IDs supplied by the analyst.
    try:
        parsed_ids = json.loads(event_ids_to_exclude)

        if isinstance(parsed_ids, str):
            excluded_ids = [parsed_ids]

        elif isinstance(parsed_ids, list):
            excluded_ids = parsed_ids

        else:
            raise ValueError("Invalid event ID format.")

    except json.JSONDecodeError:
        # Support a single plain event ID submitted by Swagger.
        excluded_ids = [event_ids_to_exclude.strip()]

    if (
        not isinstance(excluded_ids, list)
        or not all(
            isinstance(event_id, str) and event_id.strip()
            for event_id in excluded_ids
        )
    ):
        raise HTTPException(
            status_code=400,
            detail="Event IDs must be a list of non-empty strings."
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
        # Stage 1: Create a temporary copy of the uploaded dataset.
        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=extension,
            delete=False
        ) as temp_file:
            temp_file.write(content)
            temp_path = Path(temp_file.name)

        # Stage 2: Ingest and normalize the original dataset.
        ingestion_result = ingest_file(
            temp_path,
            source_name=original_filename
        )

        events = ingestion_result["events"]

        # Stage 3: Run the counterfactual simulation.
        result = run_counterfactual(
            events=events,
            event_ids_to_exclude=excluded_ids,
            reason=reason
        )

        # Stage 4: Return the comparison.
        return {
            "status": "success",
            "dataset": original_filename,
            "summary": {
                "total_records": ingestion_result["total_records"],
                "valid_events": ingestion_result["valid_count"],
                "quarantined_records": ingestion_result["quarantined_count"]
            },
            "counterfactual": result
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
