"""SQL persistence for the soc schema (soc_api role: SELECT + INSERT only). Callers own the transaction."""
import json
import uuid

from sqlalchemy import text
from sqlalchemy.engine import Connection


def find_dataset(conn: Connection, file_sha256: str):
    return conn.execute(text("SELECT dataset_id, canonical_filename FROM soc.datasets WHERE file_sha256 = :h"),
                        {"h": file_sha256}).mappings().first()


def record_duplicate_upload(conn: Connection, dataset_id: str, filename: str, request_id: str) -> None:
    conn.execute(text("INSERT INTO soc.dataset_uploads (dataset_id, original_filename, was_duplicate, request_id) "
                      "VALUES (:d, :f, true, :r)"), {"d": dataset_id, "f": filename, "r": request_id})


def insert_dataset(conn: Connection, ing: dict, filename: str, size: int, fmt: str, request_id: str) -> None:
    conn.execute(text(
        "INSERT INTO soc.datasets (dataset_id, file_sha256, canonical_filename, file_size_bytes, file_format, "
        "total_records, valid_events, quarantined_records) VALUES (:d, :h, :f, :s, :fmt, :t, :v, :q)"),
        {"d": ing["dataset_id"], "h": ing["file_sha256"], "f": filename, "s": size, "fmt": fmt,
         "t": ing["total_records"], "v": ing["valid_count"], "q": ing["quarantined_count"]})
    conn.execute(text("INSERT INTO soc.dataset_uploads (dataset_id, original_filename, was_duplicate, request_id) "
                      "VALUES (:d, :f, false, :r)"), {"d": ing["dataset_id"], "f": filename, "r": request_id})
    if ing["events"]:
        conn.execute(text(
            "INSERT INTO soc.source_events (dataset_id, event_id, timestamp, event_type, username, source_ip, "
            "destination_ip, host, resource, outcome, source_file, line_number, raw_text, raw_sha256, "
            "canonical_json_sha256, raw_record) VALUES (:dataset_id, :event_id, :timestamp, :event_type, :username, "
            ":source_ip, :destination_ip, :host, :resource, :outcome, :source, :line_number, :raw_text, :raw_hash, "
            ":canonical_json_sha256, CAST(:raw_record AS jsonb))"),
            [{**e.model_dump(exclude={"raw_record"}), "raw_record": json.dumps(e.raw_record, default=str)}
             for e in ing["events"]])
    if ing["quarantined_records"]:
        conn.execute(text("INSERT INTO soc.quarantined_records (dataset_id, row_number, reason, raw_record) "
                          "VALUES (:d, :n, :r, CAST(:raw AS jsonb))"),
                     [{"d": ing["dataset_id"], "n": q["row_number"], "r": q["reason"],
                       "raw": json.dumps(q["raw_record"], default=str)} for q in ing["quarantined_records"]])


def insert_case(conn: Connection, dataset_id: str, c: dict) -> None:
    aid = str(uuid.uuid4())
    a = c["assessment"]
    conn.execute(text("INSERT INTO soc.cases (case_id, dataset_id, correlation_key, anchor_event_id, title) "
                      "VALUES (:case_id, :d, :k, :anchor, :title)"),
                 {"case_id": c["case_id"], "d": dataset_id, "k": c["correlation_key"],
                  "anchor": c["anchor_event_id"], "title": c["title"]})
    conn.execute(text(
        "INSERT INTO soc.case_assessments (assessment_id, case_id, revision, cause, verdict, verdict_rationale, "
        "severity, risk_value, risk_band, risk_reasoning, confidence_level, confidence_rationale, coverage_ratio, "
        "coverage_present, coverage_missing, primary_entities, graph) VALUES (:aid, :case_id, 1, 'initial', :verdict, "
        ":verdict_rationale, :severity, :risk_value, :risk_band, :risk_reasoning, :confidence_level, "
        ":confidence_rationale, :coverage_ratio, :coverage_present, :coverage_missing, :primary_entities, "
        "CAST(:graph AS jsonb))"),
        {**a, "aid": aid, "case_id": c["case_id"], "graph": json.dumps(a["graph"])})
    conn.execute(text("INSERT INTO soc.case_events (case_id, dataset_id, event_id, added_in_assessment_id) "
                      "VALUES (:c, :d, :e, :a)"),
                 [{"c": c["case_id"], "d": dataset_id, "e": e, "a": aid} for e in c["event_ids"]])
    for f in c["findings"]:
        conn.execute(text("INSERT INTO soc.findings (assessment_id, case_id, finding_id, rule_id, title, description, "
                          "severity, stance, weight, evidence) VALUES (:a, :c, :fid, :rule, :title, :desc, :sev, "
                          ":stance, :w, CAST(:ev AS jsonb))"),
                     {"a": aid, "c": c["case_id"], "fid": f["finding_id"], "rule": f["rule_id"], "title": f["title"],
                      "desc": f["description"], "sev": f["severity"], "stance": f["stance"], "w": f["weight"],
                      "ev": json.dumps(f["evidence"], default=str)})
        conn.execute(text("INSERT INTO soc.finding_events (assessment_id, finding_id, case_id, dataset_id, event_id, "
                          "ordinal) VALUES (:a, :f, :c, :d, :e, :o)"),
                     [{"a": aid, "f": f["finding_id"], "c": c["case_id"], "d": dataset_id, "e": e, "o": i + 1}
                      for i, e in enumerate(f["event_ids"])])
    for m in c["attack_mappings"]:
        conn.execute(text("INSERT INTO soc.attack_mappings (assessment_id, case_id, technique_id, name, tactic) "
                          "VALUES (:a, :c, :t, :n, :tac)"),
                     {"a": aid, "c": c["case_id"], "t": m["technique_id"], "n": m["name"], "tac": m["tactic"]})
        conn.execute(text("INSERT INTO soc.attack_mapping_events (assessment_id, technique_id, case_id, dataset_id, "
                          "event_id) VALUES (:a, :t, :c, :d, :e)"),
                     [{"a": aid, "t": m["technique_id"], "c": c["case_id"], "d": dataset_id, "e": e}
                      for e in m["event_ids"]])
    if c["missing_evidence"]:
        conn.execute(text("INSERT INTO soc.missing_evidence (assessment_id, case_id, missing_id, telemetry, "
                          "why_it_matters) VALUES (:a, :c, :m, :t, :w)"),
                     [{"a": aid, "c": c["case_id"], "m": x["missing_id"], "t": x["telemetry"],
                       "w": x["why_it_matters"]} for x in c["missing_evidence"]])


# ----------------------------------------------------------------- reads
def list_case_rows(conn: Connection, dataset_id: str | None = None):
    sql = "SELECT * FROM soc.case_current" + (" WHERE dataset_id = :d" if dataset_id else "") + \
          " ORDER BY risk_value DESC, last_seen DESC, case_id"
    return conn.execute(text(sql), {"d": dataset_id} if dataset_id else {}).mappings().all()


def get_case_row(conn: Connection, case_id: str):
    return conn.execute(text("SELECT * FROM soc.case_current WHERE case_id = :c"), {"c": case_id}).mappings().first()


def case_events(conn: Connection, case_id: str):
    return conn.execute(text("SELECT * FROM soc.case_event_view WHERE case_id = :c "
                             "ORDER BY timestamp, source_file, line_number, event_id"), {"c": case_id}).mappings().all()


def case_children(conn: Connection, case_id: str, assessment_id):
    p = {"c": case_id, "a": assessment_id}
    findings = conn.execute(text(
        "SELECT f.*, coalesce((SELECT array_agg(fe.event_id ORDER BY fe.ordinal) FROM soc.finding_events fe "
        "WHERE fe.assessment_id = f.assessment_id AND fe.finding_id = f.finding_id), '{}') AS event_ids "
        "FROM soc.findings f WHERE f.assessment_id = :a ORDER BY f.finding_id"), {"a": assessment_id}).mappings().all()
    attack = conn.execute(text(
        "SELECT m.*, coalesce((SELECT array_agg(e.event_id ORDER BY e.event_id) FROM soc.attack_mapping_events e "
        "WHERE e.assessment_id = m.assessment_id AND e.technique_id = m.technique_id), '{}') AS event_ids "
        "FROM soc.attack_mappings m WHERE m.assessment_id = :a ORDER BY m.technique_id"),
        {"a": assessment_id}).mappings().all()
    missing = conn.execute(text("SELECT * FROM soc.missing_evidence WHERE assessment_id = :a ORDER BY missing_id"),
                           {"a": assessment_id}).mappings().all()
    decisions = conn.execute(text("SELECT * FROM soc.analyst_decisions WHERE case_id = :c ORDER BY seq"),
                             {"c": case_id}).mappings().all()
    return findings, attack, missing, decisions


def quarantine_rows(conn: Connection, dataset_id: str):
    return conn.execute(text("SELECT row_number, reason FROM soc.quarantined_records WHERE dataset_id = :d "
                             "ORDER BY row_number"), {"d": dataset_id}).mappings().all()


def dataset_row(conn: Connection, dataset_id: str):
    return conn.execute(text("SELECT * FROM soc.datasets WHERE dataset_id = :d"), {"d": dataset_id}).mappings().first()
