
from app.services.llm_reporting import (
    _validate_llm_output,
    generate_llm_narrative,
)


def test_valid_llm_output():
    result = {
        "executive_summary": "A suspicious login sequence was detected.",
        "incident_explanations": [
            {
                "incident_id": "inc_1",
                "explanation": "Multiple failed attempts preceded a suspicious login.",
            }
        ],
        "claim_explanations": [
            {
                "claim_index": 0,
                "explanation": "The finding is supported by the cited events.",
            }
        ],
    }

    assert _validate_llm_output(result, 1, ["inc_1"]) is True



def test_invalid_claim_index():
    result = {
        "executive_summary": "Summary",
        "incident_narrative": "Narrative",
        "claim_explanations": [
            {
                "claim_index": 5,
                "explanation": "Unsupported claim.",
            }
        ],
    }

    assert _validate_llm_output(result, 1) is False


def test_duplicate_claim_indices():
    result = {
        "executive_summary": "Summary",
        "incident_narrative": "Narrative",
        "claim_explanations": [
            {"claim_index": 0, "explanation": "First."},
            {"claim_index": 0, "explanation": "Duplicate."},
        ],
    }

    assert _validate_llm_output(result, 1) is False


def test_missing_claim_explanation():
    result = {
        "executive_summary": "Summary",
        "incident_narrative": "Narrative",
        "claim_explanations": [],
    }

    assert _validate_llm_output(result, 1) is False


def test_missing_api_key_uses_fallback(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    original = {
        "executive_summary": "Deterministic report",
        "claims": [],
    }

    result = generate_llm_narrative(original)

    assert result["llm_status"] == "fallback"
    assert result["executive_summary"] == "Deterministic report"

def test_rejects_unknown_incident_id():
    result = {
        "executive_summary": "Summary",
        "incident_explanations": [
            {
                "incident_id": "inc_wrong",
                "explanation": "Unsupported association.",
            }
        ],
        "claim_explanations": [
            {
                "claim_index": 0,
                "explanation": "Supported claim.",
            }
        ],
    }

    assert _validate_llm_output(
        result,
        1,
        ["inc_1"],
    ) is False


def test_rejects_missing_incident_explanation():
    result = {
        "executive_summary": "Summary",
        "incident_explanations": [],
        "claim_explanations": [
            {
                "claim_index": 0,
                "explanation": "Supported claim.",
            }
        ],
    }

    assert _validate_llm_output(
        result,
        1,
        ["inc_1"],
    ) is False
