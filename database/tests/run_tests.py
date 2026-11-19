#!/usr/bin/env python3
"""SOC Sentinel database verification.

Starts a DISPOSABLE PostgreSQL cluster (temp data dir, loopback only, random port), applies supabase/migrations/*.sql
exactly as Supabase would (one transaction per file, as a NON-superuser owner), then runs:
  * static safety checks on the migration files (no destructive SQL, no secrets, naming/order)
  * SQL tests in database/tests/sql (structure, ingestion, cases, evidence, reports/decisions, investigation, adversarial, security)
  * cross-language checks: Python hashlib vs the database's derive_* functions (database/tests/vectors.json)
  * concurrency / retry / failure / timeout tests of the investigation budget using real parallel sessions as role soc_api

It never connects to any remote server. Usage:
    python database/tests/run_tests.py [--pg-bin "C:/Program Files/PostgreSQL/17/bin"] [--keep] [--no-supabase-stubs]
Requires only PostgreSQL server binaries (initdb, postgres, psql, pg_ctl) and Python 3.9+. No third-party packages.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = Path(os.environ.get("SOC_MIGRATIONS_DIR", ROOT / "supabase" / "migrations"))   # override only for mutation testing of the tests themselves
SQL_DIR = Path(__file__).resolve().parent / "sql"
VECTORS = Path(__file__).resolve().parent / "vectors.json"
EXE = ".exe" if os.name == "nt" else ""
SEP = "\x1f"
RESULTS: list[tuple[str, bool, str]] = []
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


# ------------------------------------------------------------------ reference implementations (what the backend must reproduce)
def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def derive_dataset_id(file_sha256: str) -> str:
    return "ds_" + file_sha256[:16]


def derive_event_id(dataset_id: str, source_file: str, line_number: int, raw_sha256: str) -> str:
    return "evt_" + sha256_hex(SEP.join([dataset_id, source_file, str(line_number), raw_sha256]))[:16]


def derive_case_id(dataset_id: str, correlation_key: str, anchor_event_id: str) -> str:
    return "case_" + sha256_hex(SEP.join([dataset_id, correlation_key, anchor_event_id]))[:16]


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""), flush=True)


# ------------------------------------------------------------------ postgres plumbing
def find_pg_bin(arg: str | None) -> Path:
    cands = [arg, os.environ.get("PG_BIN")]
    cands += sorted((str(p) for p in Path("C:/Program Files/PostgreSQL").glob("*/bin")), reverse=True) if os.name == "nt" else []
    cands += ["/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin", "/opt/homebrew/opt/postgresql@17/bin", "/usr/local/bin"]
    w = shutil.which("initdb")
    if w:
        cands.append(str(Path(w).parent))
    for c in cands:
        if c and (Path(c) / f"initdb{EXE}").exists() and (Path(c) / f"psql{EXE}").exists():
            return Path(c)
    sys.exit("PostgreSQL server binaries not found. Pass --pg-bin or set PG_BIN.")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Cluster:
    def __init__(self, bin_dir: Path, keep: bool):
        self.bin, self.keep = bin_dir, keep
        self.dir = Path(tempfile.mkdtemp(prefix="soc_pg_"))
        self.port = free_port()
        self.proc: subprocess.Popen | None = None
        self.log = self.dir / "server.log"

    def start(self) -> None:
        data = self.dir / "data"
        subprocess.run([str(self.bin / f"initdb{EXE}"), "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], check=True, capture_output=True)
        self.proc = subprocess.Popen(
            [str(self.bin / f"postgres{EXE}"), "-D", str(data), "-p", str(self.port), "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off", "-c", "max_connections=60", "-c", "log_min_messages=warning"],
            stdout=open(self.log, "w"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        for _ in range(100):
            if self.psql("postgres", "SELECT 1", user="postgres").returncode == 0:
                return
            time.sleep(0.2)
        sys.exit(f"postgres did not start; see {self.log}")

    def stop(self) -> None:
        if self.proc:
            subprocess.run([str(self.bin / f"pg_ctl{EXE}"), "-D", str(self.dir / "data"), "stop", "-m", "fast", "-w"], capture_output=True)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if not self.keep:
            shutil.rmtree(self.dir, ignore_errors=True)

    def psql(self, db: str, sql: str | None = None, user: str = "postgres", file: Path | None = None, stdin: str | None = None,
             verbose: bool = True, timeout: int = 120, single_tx: bool = False, extra: list[str] | None = None) -> subprocess.CompletedProcess:
        cmd = [str(self.bin / f"psql{EXE}"), "-X", "-q", "-h", "127.0.0.1", "-p", str(self.port), "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1"]
        cmd += ["-v", f"VERBOSITY={'verbose' if verbose else 'default'}", "-A", "-t"]
        if single_tx:
            cmd.append("-1")
        cmd += extra or []
        if sql is not None and stdin is None and not sql.isascii():
            stdin, sql = sql, None          # non-ASCII SQL goes through stdin as UTF-8 (command-line encoding is unreliable on Windows)
        if sql is not None:
            cmd += ["-c", sql]
        if file is not None:
            cmd += ["-f", str(file)]
        if stdin is not None:
            cmd += ["-f", "-"]
        env = {**os.environ, "PGCLIENTENCODING": "UTF8"}
        return subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=timeout)


def sqlstate(cp: subprocess.CompletedProcess) -> str | None:
    m = re.search(r"ERROR:\s+([0-9A-Z]{5}):", cp.stderr)
    return m.group(1) if m else None


def val(cp: subprocess.CompletedProcess) -> str:
    return cp.stdout.strip()


# ------------------------------------------------------------------ static checks
FORBIDDEN = [
    (r"\bDROP\s+(TABLE|SCHEMA|ROLE|DATABASE|VIEW|FUNCTION|TRIGGER|POLICY|INDEX|CONSTRAINT|COLUMN)\b", "DROP statement"),
    (r"\bTRUNCATE\b", "TRUNCATE"),
    (r"\bDELETE\s+FROM\b", "DELETE FROM"),
    (r"\bALTER\s+TABLE\b[^;]*\bDROP\b", "ALTER TABLE ... DROP"),
    (r"\bCASCADE\b", "CASCADE"),
    (r"\bCREATE\s+EXTENSION\b", "CREATE EXTENSION (none needed)"),
    (r"\bPASSWORD\b", "password literal"),
    (r"\bTO\s+(PUBLIC|anon|authenticated)\b", "grant to PUBLIC/anon/authenticated"),
    (r"^\s*(BEGIN|COMMIT|ROLLBACK)\s*;", "explicit transaction control (the migration runner owns the transaction)"),
    (r"^\s*\\", "psql meta-command"),
    (r"CONCURRENTLY", "CONCURRENTLY (cannot run in a transaction)"),
]
SECRETS = [r"postgres(ql)?://[^\s'\"<:]+:(?![<\[$%{])[^@\s'\"]+@", r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}", r"sb_secret_[A-Za-z0-9]+", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", r"(?i)service_role[\"' ]*[:=][\"' ]*ey"]


def strip_sql_comments(sql: str) -> str:
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"/\*.*?\*/", "", sql, flags=re.S)


def static_checks() -> None:
    files = sorted(MIGRATIONS.glob("*.sql"))
    optional = sorted((ROOT / "database" / "optional").glob("*.sql"))
    record("static: migration files found", len(files) >= 5, ", ".join(f.name for f in files))
    names = [f.name for f in files]
    record("static: filenames are <14-digit timestamp>_<name>.sql and strictly ascending", all(re.fullmatch(r"\d{14}_[a-z0-9_]+\.sql", n) for n in names) and names == sorted(names) and len({n[:14] for n in names}) == len(names))
    for f in files + optional:
        raw = f.read_text(encoding="utf-8")
        code = strip_sql_comments(raw)
        # string literals can legitimately contain words like 'PASSWORD'; blank them before scanning
        scan = re.sub(r"'(?:[^']|'')*'", "''", code)
        bad = [label for pat, label in FORBIDDEN if re.search(pat, scan, flags=re.I | re.M)]
        record(f"static: {f.name} is non-destructive and policy-clean", not bad, "; ".join(bad))
        record(f"static: {f.name} is plain ASCII", all(ord(c) < 128 for c in raw))
    hits = []
    for base in (ROOT / "database", ROOT / "supabase"):
        for p in base.rglob("*"):
            if p.is_file() and p.suffix in {".sql", ".md", ".py", ".json", ".toml", ".env", ".txt"} and "__pycache__" not in p.parts:
                text = p.read_text(encoding="utf-8", errors="ignore")
                for pat in SECRETS:
                    if re.search(pat, text):
                        hits.append(f"{p.relative_to(ROOT)}:{pat[:20]}")
    record("static: no connection strings with passwords, JWTs or keys in database/ or supabase/", not hits, "; ".join(hits))
    gi = (ROOT / ".gitignore").read_text(encoding="utf-8", errors="ignore") if (ROOT / ".gitignore").exists() else ""
    record("static: .env files are git-ignored", ".env" in gi, "")


# ------------------------------------------------------------------ cluster setup
def apply_migrations(c: Cluster, db: str) -> bool:
    ok = True
    for f in sorted(MIGRATIONS.glob("*.sql")):
        cp = c.psql(db, file=f, user="mig", single_tx=True, verbose=True)
        if cp.returncode != 0:
            record(f"apply {f.name} to {db}", False, cp.stderr.strip().splitlines()[-1] if cp.stderr.strip() else "error")
            ok = False
            break
    if ok:
        record(f"apply all {len(list(MIGRATIONS.glob('*.sql')))} migrations to empty database {db} (one transaction per file, non-superuser owner)", True)
    return ok


def setup(c: Cluster, supabase_stubs: bool) -> None:
    sql = ""
    if supabase_stubs:   # roles every Supabase project already has
        sql += "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; "
    sql += "CREATE ROLE mig LOGIN CREATEROLE;"   # stands in for Supabase's `postgres` migration role: NOT a superuser
    assert c.psql("postgres", sql).returncode == 0
    for db in ("soc_sql", "soc_conc", "soc_fresh"):
        assert c.psql("postgres", f"CREATE DATABASE {db} OWNER mig").returncode == 0
    for db in ("soc_sql", "soc_conc", "soc_fresh"):
        if not apply_migrations(c, db):
            raise SystemExit("migrations failed; aborting")
    for db in ("soc_sql", "soc_conc"):
        cp = c.psql(db, file=SQL_DIR / "00_helpers.sql")
        assert cp.returncode == 0, cp.stderr


# ------------------------------------------------------------------ SQL tests
def run_sql_tests(c: Cluster, stubs: bool = True) -> None:
    for f in sorted(SQL_DIR.glob("0[1-8]_*.sql")):
        if not stubs and f.name.startswith("08_"):
            print(f"SKIP  sql tests: {f.name} (needs the Supabase role stubs; not run with --no-supabase-stubs)")
            continue
        cp = c.psql("soc_sql", file=f, verbose=False, timeout=300)
        passes = len(re.findall(r"NOTICE:\s+PASS:", cp.stderr))
        ok = cp.returncode == 0 and passes > 0
        detail = f"{passes} assertions"
        if not ok:
            lines = [ln for ln in cp.stderr.splitlines() if "TEST FAILED" in ln or "ERROR" in ln]
            detail = (lines[0] if lines else cp.stderr.strip()[-300:])[:400]
        record(f"sql tests: {f.name}", ok, detail)


def vector_checks(c: Cluster) -> None:
    v = json.loads(VECTORS.read_text(encoding="utf-8"))
    bad = []
    for item in v["sha256_hex"]:
        db = val(c.psql("soc_sql", "SELECT soc.sha256_hex($t$" + item["input"] + "$t$)"))
        if db != sha256_hex(item["input"]) or db != item["expected"]:
            bad.append(("sha256", item["input"][:20]))
    for item in v["dataset_id"]:
        if derive_dataset_id(item["file_sha256"]) != item["expected"] or val(c.psql("soc_sql", f"SELECT soc.derive_dataset_id('{item['file_sha256']}')")) != item["expected"]:
            bad.append(("dataset", item["file_sha256"][:8]))
    for item in v["event_id"]:
        a = item["args"]
        py = derive_event_id(a["dataset_id"], a["source_file"], a["line_number"], a["raw_sha256"])
        db = val(c.psql("soc_sql", "SELECT soc.derive_event_id($t$%s$t$, $t$%s$t$, %d, '%s')" % (a["dataset_id"], a["source_file"], a["line_number"], a["raw_sha256"])))
        if not (py == db == item["expected"]):
            bad.append(("event", a["source_file"]))
    for item in v["case_id"]:
        a = item["args"]
        py = derive_case_id(a["dataset_id"], a["correlation_key"], a["anchor_event_id"])
        db = val(c.psql("soc_sql", "SELECT soc.derive_case_id($t$%s$t$, $t$%s$t$, $t$%s$t$)" % (a["dataset_id"], a["correlation_key"], a["anchor_event_id"])))
        if not (py == db == item["expected"]):
            bad.append(("case", a["correlation_key"]))
    n = len(v["sha256_hex"]) + len(v["dataset_id"]) + len(v["event_id"]) + len(v["case_id"])
    record(f"cross-language: Python hashlib == PostgreSQL derive_* for {n} reference vectors (incl. unicode)", not bad, str(bad))


# ------------------------------------------------------------------ concurrency / failure tests (committed data, real parallel sessions as soc_api)
def world(c: Cluster, seed: str) -> dict:
    cp = c.psql("soc_conc", f"SELECT soc_test.mk_world('{seed}')::text")
    assert cp.returncode == 0, cp.stderr
    return json.loads(val(cp))


def worker_script(w: dict, key: str, req: str, sleep: float = 0.25, pre: str = "", end: str = "COMMIT;") -> str:
    return f"""{pre}
BEGIN;
SELECT outcome FROM soc.begin_investigation_query('{w['case']}', '{key}', '{req}');
SELECT pg_sleep({sleep});
SELECT soc.record_investigation_query('{w['case']}', '{key}', 'get_ip_context', '{{}}', '{req}', 'concurrency test', '{w['a1']}', '{w['a1']}', '[]');
{end}
"""


def ledger(c: Cluster, case: str) -> list[tuple[int, int]]:
    cp = c.psql("soc_conc", f"SELECT sequence_no, budget_remaining_after FROM soc.investigation_queries WHERE case_id='{case}' ORDER BY sequence_no")
    return [tuple(int(x) for x in ln.split("|")) for ln in val(cp).splitlines() if ln]


def concurrency_tests(c: Cluster) -> None:
    py = sys.executable
    # roles carry the timeouts the design relies on
    cp = c.psql("soc_conc", "SHOW lock_timeout", user="soc_api")
    cp2 = c.psql("soc_conc", "SHOW statement_timeout", user="soc_api")
    cp3 = c.psql("soc_conc", "SHOW idle_in_transaction_session_timeout", user="soc_api")
    record("soc_api sessions start with lock_timeout=10s, statement_timeout=30s, idle_in_transaction_session_timeout=1min",
           (val(cp), val(cp2), val(cp3)) == ("10s", "30s", "1min"), f"{val(cp)}/{val(cp2)}/{val(cp3)}")

    # C1: 8 parallel queries with different keys against a budget of 3
    w = world(c, "conc-budget")
    with cf.ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda i: c.psql("soc_conc", user="soc_api", stdin=worker_script(w, f"par-key-{i:04d}-abcdef", sha256_hex(f"req{i}")), timeout=60), range(8)))
    ok_n = sum(r.returncode == 0 for r in res)
    refused = [sqlstate(r) for r in res if r.returncode != 0]
    led = ledger(c, w["case"])
    record("concurrency: 8 parallel queries, budget 3 -> exactly 3 succeed, 5 refused with SC001, no overspend",
           ok_n == 3 and refused.count("SC001") == 5 and led == [(1, 2), (2, 1), (3, 0)], f"ok={ok_n} refused={refused} ledger={led}")

    # C2: same key, same request, 6 parallel retries -> one charge
    w = world(c, "conc-same-key")
    req = sha256_hex("same")
    with cf.ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda i: c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "retry-key-abcdefgh", req, 0.15), timeout=60), range(6)))
    led = ledger(c, w["case"])
    record("concurrency: 6 parallel retries of the SAME key -> every call succeeds, budget charged exactly once",
           all(r.returncode == 0 for r in res) and led == [(1, 2)], f"rc={[r.returncode for r in res]} ledger={led}")

    # C3: same key, different request
    w = world(c, "conc-key-reuse")
    with cf.ThreadPoolExecutor(2) as ex:
        res = list(ex.map(lambda i: c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "reuse-key-abcdefgh", sha256_hex(f"diff{i}"), 0.3), timeout=60), range(2)))
    states = sorted((r.returncode, sqlstate(r) or "") for r in res)
    record("concurrency: one key used for two DIFFERENT requests -> one succeeds, the other is refused with SC002",
           states == [(0, ""), (3, "SC002")] and len(ledger(c, w["case"])) == 1, str(states))

    # C4: lock wait + lock_timeout; lock released by rollback; retry then succeeds and is charged once
    w = world(c, "conc-lock-timeout")
    req = sha256_hex("lt")
    holder = worker_script(w, "holder-key-abcdefgh", req, sleep=3, end="ROLLBACK;").replace("SELECT soc.record_investigation_query", "-- skipped: SELECT soc.record_investigation_query")
    with cf.ThreadPoolExecutor(2) as ex:
        fa = ex.submit(lambda: c.psql("soc_conc", user="soc_api", stdin=holder, timeout=60))
        time.sleep(0.8)
        fb = ex.submit(lambda: c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "waiter-key-abcdefgh", sha256_hex("w"), 0.1, pre="SET lock_timeout='500ms';"), timeout=60))
        ra, rb = fa.result(), fb.result()
    record("failure: a request that cannot get the per-case lock within lock_timeout fails with 55P03 (no charge)", sqlstate(rb) == "55P03" and ledger(c, w["case"]) == [], f"holder_rc={ra.returncode} waiter={sqlstate(rb)}")
    rc = c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "waiter-key-abcdefgh", sha256_hex("w"), 0.1), timeout=60)
    record("retry: the same key succeeds once the lock is free, and is charged exactly once", rc.returncode == 0 and ledger(c, w["case"]) == [(1, 2)], str(ledger(c, w["case"])))

    # C5: statement timeout inside the transaction -> rollback, nothing charged
    w = world(c, "conc-stmt-timeout")
    rs = c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "slow-key-abcdefghi", sha256_hex("s"), sleep=2, pre="SET statement_timeout='300ms';"), timeout=60)
    record("timeout: statement_timeout aborts a slow transaction (57014); the budget is untouched", sqlstate(rs) == "57014" and ledger(c, w["case"]) == [], f"state={sqlstate(rs)}")
    rr = c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "slow-key-abcdefghi", sha256_hex("s"), 0.05), timeout=60)
    record("retry after timeout: the same key succeeds and is charged once", rr.returncode == 0 and ledger(c, w["case"]) == [(1, 2)])

    # C6: a client that stalls inside the transaction is disconnected by idle_in_transaction_session_timeout, releasing the lock
    w = world(c, "conc-idle")
    stall = f"""SET idle_in_transaction_session_timeout='1s';
BEGIN;
SELECT outcome FROM soc.begin_investigation_query('{w['case']}', 'stall-key-abcdefghi', '{sha256_hex('stall')}');
\\! {py} -c "import time; time.sleep(3)"
SELECT 1;
COMMIT;
"""
    with cf.ThreadPoolExecutor(2) as ex:
        fa = ex.submit(lambda: c.psql("soc_conc", user="soc_api", stdin=stall, timeout=60))
        time.sleep(0.4)
        t0 = time.time()
        fb = ex.submit(lambda: c.psql("soc_conc", user="soc_api", stdin=worker_script(w, "after-stall-abcdefg", sha256_hex("after"), 0.05), timeout=60))
        ra, rb = fa.result(), fb.result()
        waited = time.time() - t0
    record("timeout: a stalled client is cut off by idle_in_transaction_session_timeout; its lock is released and it is not charged",
           ra.returncode != 0 and sqlstate(ra) in ("25P03", None) and ledger(c, w["case"]) == [(1, 2)], f"stalled_rc={ra.returncode} state={sqlstate(ra)} ledger={ledger(c, w['case'])}")
    record("concurrency: the waiting request proceeds as soon as the stalled session is killed", rb.returncode == 0 and waited < 9, f"waited {waited:.1f}s")

    # C7: assessments gap-free under concurrent writers (two revisions at once -> exactly one 2, other refused)
    w = world(c, "conc-revision")
    def add_rev(i: int):
        return c.psql("soc_conc", user="soc_api", stdin=f"""BEGIN;
SELECT pg_sleep(0.2);
INSERT INTO soc.case_assessments (case_id, revision, cause, verdict, verdict_rationale, severity, risk_value, risk_band, confidence_level, confidence_rationale, coverage_ratio)
VALUES ('{w['case']}', 2, 'investigation', 'likely_malicious', 'r{i}', 'high', 70, 'high', 'medium', 'c', 0.8);
COMMIT;""", timeout=60)
    with cf.ThreadPoolExecutor(2) as ex:
        res = list(ex.map(add_rev, range(2)))
    n = val(c.psql("soc_conc", f"SELECT count(*) FROM soc.case_assessments WHERE case_id='{w['case']}'"))
    record("concurrency: two writers racing for revision 2 -> exactly one wins, the other is refused (no duplicate / skipped revision)",
           n == "2" and sorted(sqlstate(r) or "ok" for r in res) == ["SC210", "ok"], f"count={n} states={[sqlstate(r) or 'ok' for r in res]}")


def optional_tests(c: Cluster) -> None:
    opt = ROOT / "database" / "optional"
    c.psql("postgres", "CREATE DATABASE soc_opt OWNER mig")
    ok = True
    for f in sorted(MIGRATIONS.glob("*.sql")) + sorted(opt.glob("*.sql")):
        ok &= c.psql("soc_opt", file=f, user="mig", single_tx=True).returncode == 0
    record("optional counterfactual migration applies on top of the core migrations", ok)
    if ok:
        c.psql("soc_opt", file=SQL_DIR / "00_helpers.sql")
        cp = c.psql("soc_opt", file=SQL_DIR / "09_optional_counterfactual.sql", verbose=False)
        passes = len(re.findall(r"NOTICE:\s+PASS:", cp.stderr))
        detail = f"{passes} assertions" if cp.returncode == 0 else ([ln for ln in cp.stderr.splitlines() if "TEST FAILED" in ln or "ERROR" in ln] or [cp.stderr[-300:]])[0][:400]
        record("sql tests: 09_optional_counterfactual.sql (original case preserved)", cp.returncode == 0 and passes > 0, detail)


# ------------------------------------------------------------------ main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pg-bin")
    ap.add_argument("--keep", action="store_true", help="keep the temp cluster directory")
    ap.add_argument("--no-supabase-stubs", action="store_true", help="do not create anon/authenticated/service_role (tests a plain PostgreSQL)")
    ap.add_argument("--only-static", action="store_true")
    args = ap.parse_args()

    static_checks()
    if args.only_static:
        return summarize()
    c = Cluster(find_pg_bin(args.pg_bin), args.keep)
    try:
        c.start()
        ver = val(c.psql("postgres", "SHOW server_version"))
        print(f"-- disposable PostgreSQL {ver} on 127.0.0.1:{c.port} (target Supabase: 17.x)", flush=True)
        setup(c, not args.no_supabase_stubs)
        tables = val(c.psql("soc_fresh", "SELECT count(*) FROM pg_tables WHERE schemaname='soc'"))
        record("fresh database ends with the expected 22 tables and no objects outside schema soc",
               tables == "22" and val(c.psql("soc_fresh", "SELECT count(*) FROM pg_tables WHERE schemaname='public'")) == "0")
        run_sql_tests(c, not args.no_supabase_stubs)
        vector_checks(c)
        concurrency_tests(c)
        optional_tests(c)
    finally:
        c.stop()
    return summarize()


def summarize() -> int:
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    for n, _, d in failed:
        print(f"  FAILED: {n} {d}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
