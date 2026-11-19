from fastapi import FastAPI

from app.api.routes import router
from app.api.cases import router as cases_router
from dotenv import load_dotenv

load_dotenv()
app = FastAPI(
    title="SOC Sentinel",
    description="Security Alert Triage and Investigation System",
    version="1.0.0"
)

app.include_router(router)
app.include_router(cases_router)


@app.get("/")
def root():
    return {"message": "SOC Sentinel API is running"}


@app.get("/health")
def health():
    return {"status": "healthy"}