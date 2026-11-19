# Deployment-readiness audit (before applying to Supabase PostgreSQL 17.12)

_Scope: the five migrations in `supabase/migrations/`, `database/README.md`, the test harness. Nothing was applied anywhere. Audit performed against PostgreSQL 18.6 (the only version available locally) plus a static review for 17._

## Verdict

**READY TO DEPLOY, subject to the conditions below.** The audit found **no blocker that would break an apply or open the data to the public**, but it did find **two real defects, both now fixed in this branch**, and several platform behaviours that only a real Supabase project can confirm. The first is the reason the safeguards in "Conditions" exist.

| | |
|---|---|
| Defects found and fixed | (1) Security depended on a platform default (see D1). (2) Hard length caps could make a hostile or unusual log value fail a whole upload (D2). |
| Not verifiable locally | PostgreSQL **17** itself; Supabase's `postgres` role attributes, `supautils` behaviour, pooler login, Data API settings. |
| Safeguards added | `soc.lock_down_schema()`, `database/audit/post_deploy_audit.sql` (read-only; 15 checks), a harsher test harness. |

### Conditions (do these before pointing the backend at the database)
1. Run `python database/tests/run_tests.py` on **PostgreSQL 17.x binaries** (README §0).
2. Apply with the CLI (`db push --dry-run`, then `db push`), run the **post-deploy audit** and require **no FAIL**.
3. Set the backend password with `\password` (not via the SQL Editor), then run the connection check (README §5).

## Findings by requested area

### 1. PostgreSQL 17 compatibility: compatible (statically verified; not run on 17)
No extensions are created or required. Every feature used exists in PostgreSQL ≤ 16 or 17; nothing is 18-only.

| Feature used | Minimum version |
|---|---|
| `sha256(bytea)`, `hashtextextended`, `pg_advisory_xact_lock` | 11 |
| `gen_random_uuid()` in core (no pgcrypto) | 13 |
| `GENERATED ... STORED` column, `GENERATED ALWAYS AS IDENTITY` | 12 / 10 |
| View option `security_invoker` | 15 |
| `FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `CONSTRAINT TRIGGER`, composite `MATCH SIMPLE` FKs | 9.5 / 9.1 |
| Creator of a role receives ADMIN OPTION (so `ALTER ROLE ... SET` works for a CREATEROLE migration role) | 16 |
| `jsonb`, `jsonb_each`, `jsonb_array_elements_text`, `format('%I')`, `concat_ws` | ≤ 9.5 |

Not used (18-only): virtual generated columns, `uuidv7()`, `OLD/NEW` in `RETURNING`, `NOT NULL` as catalog constraints. PostgreSQL 17's "safe search_path during maintenance" (REINDEX/VACUUM/ANALYZE) cannot affect this schema: there are no expression indexes, and every function pins `search_path` and schema-qualifies its callees. What a 17 run could still reveal: differences in error texts/SQLSTATEs asserted by the tests (not in the migrations).

### 2. Supabase roles and forced RLS: `soc_api` can read and insert (verified); the admin role is the open point
* Verified (as a non-superuser role with CREATEROLE, mimicking Supabase `postgres`): migrations apply; `soc_api` can `SELECT` and `INSERT` every table, use the identity column, execute the investigation functions and read all views; `soc_readonly` reads only. Policies exist only for those two roles; with `FORCE ROW LEVEL SECURITY` an owner **without** `BYPASSRLS` sees zero rows (tested).
* **To confirm on Supabase:** the `postgres` role normally holds `BYPASSRLS`. The audit's row 15 shows its value. If it is not `true`, admin queries as `postgres` will return 0 rows from `soc` tables (use `soc_readonly` for admin reads). Backend behaviour is unaffected.
* Platform unknown: Supabase's `supautils` can restrict role DDL. `CREATE ROLE` for a non-reserved role and `ALTER ROLE ... SET` of ordinary GUCs are normally allowed. Because each migration is atomic, a refusal leaves nothing behind; if it happens, run the `ALTER ROLE ... SET` lines manually.

### 3. `soc` excluded from PostgREST: yes, by default, enforced in depth
* Supabase exposes only `public` and `graphql_public` unless you add a schema (stored as `pgrst.db_schemas` on the `authenticator` role). Nothing in the migrations changes that. The audit reads that setting (row 6) and README §4 gives a live `curl` check.
* Defence in depth: `anon`, `authenticated` and `service_role` hold **no** privilege on the schema or on any table, view, sequence or function in it (row 5). Even a mistakenly exposed `soc` would refuse them. `pg_graphql` only exposes what the role can already select (nothing).

### 4. ID derivation and SHA-256 checks vs the documented contract: consistent
* `raw_sha256 = SHA-256(UTF-8(raw_text))` matches BIR §2.4 (`raw_hash` is the SHA-256 of `raw_text`). Python and PostgreSQL agree on 14 vectors including Unicode. SHA-256 is computed over UTF-8 bytes regardless of the database encoding (audit row 2 reports the encoding).
* The documented deviations from **today's backend code** (not from the contract): the old `raw_hash` hashes the parsed JSON and the old `event_id` is not dataset-scoped. These are the intended transition and are listed in `MEMBER1_HANDOFF.md`. **Documents that now disagree with the schema and should be reconciled:** `BACKEND_INTEGRATION_REQUEST.md` §2.2 (`events.event_id` as the sole PK, `datasets` columns), §2.3 (`case_id` from `(dataset_id, correlation_key)`).
* Consistency limits that matter: `file_size_bytes` ≤ 10,485,760 equals the backend's `MAX_FILE_SIZE`; `valid + quarantined = total` equals the backend's counts; filenames containing `/`, `\` or control characters are rejected (the backend must sanitize; `Path(name).name` does not strip backslashes on Linux).

### 5. Re-applying through Supabase migration tracking: safe
* The CLI skips applied versions, so `db push` is repeatable. A failed file is atomic (nothing kept) and can be fixed and re-pushed. Applying a file twice by hand fails at `CREATE SCHEMA soc` ("already exists") and changes nothing. No migration contains DROP/TRUNCATE/DELETE/CASCADE (statically enforced).
* Caveat (fixed in README): the SQL Editor is untracked; if used, wrap each file in a transaction yourself and run `supabase migration repair --status applied <version>`.
* Statement splitting: the files use only `$$` dollar quoting, no psql meta-commands, no `CONCURRENTLY`, no explicit transaction control, and (fixed) no apostrophes in `--` comments, which some splitters mishandle.

### 6. Excess permissions / exposed evidence: none for API roles
Defects found: **D1**. Security relied on `anon`/`authenticated`/`service_role` not receiving privileges by default. With Supabase-style default privileges that auto-grant new objects, the schema `USAGE` leaked to those roles in a stress run (tables were already revoked by `secure_table`; schema, views, sequences, functions were not). **Fixed:** `soc.lock_down_schema()` is called at the end of every migration and explicitly revokes all privileges on the schema and every object from PUBLIC and the three API roles; the harness now applies migrations under worst-case default privileges, and the audit verifies it.
Residual and intended: `soc_readonly` can read all evidence; `soc_api` can insert anywhere (it cannot update, delete, truncate or create); every role inherits PUBLIC's default `CONNECT`/`TEMP` on the database and can read system catalogs; project owners using the `postgres` role (bypass) and Supabase backups can read evidence.

### 7. Can the roles authenticate with the planned connection method?
Yes, after a password is set (they are created without one, so they cannot log in until then).
* Pooler (recommended): username `soc_api.<PROJECT_REF>`, port 5432 (session) or 6543 (transaction; disable prepared statements). Direct: username `soc_api`, host `db.<ref>.supabase.co`, **IPv6 only** unless the IPv4 add-on is enabled. SSL required. Authentication is SCRAM, supported by psycopg 3.
* Role-level timeouts apply at login through pooled backends (advisory locks are transaction-scoped, so transaction pooling is safe for the investigation protocol).
* `CONNECTION LIMIT 20` is smaller than a large pooler pool: keep the pooler pool size ≤ 20 for this role.
* **Password handling:** setting it with `ALTER ROLE ... PASSWORD` in the SQL Editor may leave it in the editor history; README now uses `\password` (client-side hashing, hidden prompt).
* Cannot be verified before deployment: actual pooler login, `supautils` rules. README §5 gives the exact check.

### 8. Ordering and dependencies: correct
`...120000` (schema, roles, helpers, ingestion) → `...120100` (cases; needs ingestion) → `...120200` (reports/decisions; needs assessments) → `...120300` (investigation; needs decisions' `case_status` view and cases) → `...120400` (red team; needs only the foundation helpers). Timestamps strictly ascend; each file only references objects created by earlier files (the empty-`search_path` run and the fresh-database run confirm no hidden dependency on `public` or on an unqualified object).

## Hidden assumptions a local 18.6 run would not catch on Supabase 17, and how each is handled
| Assumption | Handling |
|---|---|
| Default privileges grant nothing to API roles | **Fixed (D1)**; tested under worst-case defaults; audit row 5. |
| Migration role can `CREATE ROLE` / `ALTER ROLE ... SET` | Verified with a non-superuser CREATEROLE role; atomic failure otherwise (§2). |
| Migration role has `BYPASSRLS` | Only needed for admin reads; audit row 15. |
| `soc` not exposed by PostgREST | Default; audit row 6 + curl check. |
| A single large upload statement finishes within `statement_timeout 30s` | Batch inserts (the integration plan specifies bulk inserts in batches). Constraint checks hash each row; 10,000 rows is small. |
| Untrusted values fit the caps | **Fixed (D2)**: caps widened to 4096 (entity fields), 8192 (resource), 20000 (titles, claims, quarantine reasons), 4096 (cited ids); beyond that the backend must quarantine rather than let the DB reject the batch. |
| Statement splitter tolerates the files | Apostrophe-free comments, `$$` only; statically enforced. |
| Database encoding is UTF-8 | Supabase default; hash is over UTF-8 bytes either way; audit row 2. |
| Pooler connection limits vs role limit | README §5. |
| Dashboard/Studio, PostgREST, pg_graphql, Realtime expose the schema | Not exposed; no grants; not in publications (none created). |

## Test status after the fixes
`python database/tests/run_tests.py` → **58/58 on PostgreSQL 18.6**: includes migrations applied under worst-case default privileges with an empty `search_path`, a read-only audit script that is proven to detect eight injected problems (each must trip its specific check), and the earlier ~560 SQL assertions, concurrency, timeout and cross-language checks. **Not run on PostgreSQL 17 and not run on Supabase.**
