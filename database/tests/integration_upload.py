"""End-to-end check on a DISPOSABLE PostgreSQL (never Supabase): real upload -> detection -> persistence -> API reads.

Run:  backend/.venv/Scripts/python database/tests/integration_upload.py [--pg-bin DIR]
Uses the real migrations, the soc_api role (INSERT/SELECT only) and the real backend pipeline. No mocks.
"""
import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "backend"))

import run_tests as rt  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pg-bin")
    args = ap.parse_args()
    cluster = rt.Cluster(rt.find_pg_bin(args.pg_bin), keep=False)
    try:
        cluster.start()
        rt.setup(cluster, True)
        os.environ["DATABASE_URL"] = f"postgresql+psycopg://soc_api@127.0.0.1:{cluster.port}/soc_fresh"
        from fastapi.testclient import TestClient
        from main import app
        client = TestClient(app)

        csv_path = ROOT / "datasets" / "demo_attack.csv"
        json_path = ROOT / "datasets" / "demo_web.json"
        for path in (csv_path, json_path):
            body = path.read_bytes()
            r = client.post("/api/upload", files={"file": (path.name, body)})
            check(f"upload {path.name} -> 200", r.status_code == 200, r.text[:300])
            if r.status_code != 200:
                continue
            up = r.json()
            check(f"{path.name}: envelope", up["schema_version"] == "1.0" and up["request_id"])
            c = up["counts"]
            check(f"{path.name}: counts add up", c["valid_events"] + c["quarantined_records"] == c["total_records"], str(c))
            check(f"{path.name}: dataset id derived from SHA-256", up["dataset_id"] == "ds_" + up["file_sha256"][:16])
            check(f"{path.name}: at least one case", len(up["cases"]) >= 1)

            n_before = int(cluster.psql("soc_fresh", "SELECT count(*) FROM soc.source_events", user="postgres").stdout.strip())
            r2 = client.post("/api/upload", files={"file": ("renamed_copy" + path.suffix, body)})
            check(f"{path.name}: duplicate upload -> 200", r2.status_code == 200, r2.text[:300])
            n_after = int(cluster.psql("soc_fresh", "SELECT count(*) FROM soc.source_events", user="postgres").stdout.strip())
            check(f"{path.name}: duplicate adds no events", n_before == n_after, f"{n_before} -> {n_after}")
            check(f"{path.name}: duplicate returns same cases", [x["case_id"] for x in r2.json()["cases"]] == [x["case_id"] for x in up["cases"]])
            check(f"{path.name}: duplicate keeps canonical filename", r2.json()["filename"] == path.name)
            ups = cluster.psql("soc_fresh", f"SELECT count(*) FILTER (WHERE was_duplicate), count(*) FROM soc.dataset_uploads WHERE dataset_id='{up['dataset_id']}'", user="postgres").stdout.strip()
            check(f"{path.name}: upload history 1 duplicate of 2", ups == "1|2", ups)

        listing = client.get("/api/cases")
        check("GET /api/cases -> 200", listing.status_code == 200)
        cases = listing.json()["cases"]
        check("cases listed", len(cases) >= 2, str(len(cases)))
        check("cases sorted by risk desc", [c["risk_score"]["value"] for c in cases] == sorted((c["risk_score"]["value"] for c in cases), reverse=True))

        for summary in cases:
            d = client.get(f"/api/cases/{summary['case_id']}")
            ok = d.status_code == 200
            check(f"GET case {summary['case_id']} -> 200", ok, d.text[:200])
            if not ok:
                continue
            j = d.json()
            ids = {e["event_id"] for e in j["events"]}
            check(f"{summary['case_id']}: event_count matches", j["summary"]["event_count"] == len(j["events"]))
            check(f"{summary['case_id']}: findings cite only case events",
                  all(f["event_ids"] and set(f["event_ids"]) <= ids for f in j["findings"]) and j["findings"])
            check(f"{summary['case_id']}: ATT&CK events in case", all(set(m["event_ids"]) <= ids for m in j["attack_mappings"]))
            check(f"{summary['case_id']}: raw_hash is sha256 of raw_text",
                  all(e["raw_hash"] == rt.sha256_hex(e["raw_text"]) for e in j["events"]))
            check(f"{summary['case_id']}: event ids re-derive",
                  all(e["event_id"] == rt.derive_event_id(j["summary"]["dataset_id"], e["source_file"], e["line_number"], e["raw_hash"]) for e in j["events"]))
            check(f"{summary['case_id']}: status open, budget 3", j["summary"]["status"] == "open" and j["planner"]["budget_remaining"] == 3)

        miss = client.get("/api/cases/case_doesnotexist")
        check("unknown case -> 404 CASE_NOT_FOUND", miss.status_code == 404 and miss.json()["error"]["code"] == "CASE_NOT_FOUND")

        bad = client.post("/api/upload", files={"file": ("x.txt", b"hello")})
        check("unsupported format -> 400", bad.status_code == 400 and bad.json()["error"]["code"] == "UNSUPPORTED_FORMAT")

        cp = cluster.psql("soc_fresh", "DELETE FROM soc.datasets", user="soc_api")
        check("soc_api cannot delete evidence", rt.sqlstate(cp) == "42501", cp.stderr[-120:])
    finally:
        cluster.stop()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
