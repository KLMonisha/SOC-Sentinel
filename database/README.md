# SOC Sentinel database

PostgreSQL schema for Supabase project `soc-sentinel` (PostgreSQL 17). Accessed **only** by the FastAPI backend; the frontend never connects to it. Deployment-readiness findings: `DEPLOYMENT_AUDIT.md`.

| Path | What |
|---|---|
| `supabase/migrations/*.sql` | The five migrations. **Single source of truth** for the schema (Supabase CLI format). |
| `database/audit/post_deploy_audit.sql` | Read-only script to run on Supabase after applying. Every row must be PASS or INFO. |
| `database/optional/*.sql` | Optional counterfactual-audit tables. Not applied unless you copy the file into `supabase/migrations/`. |
| `database/SCHEMA_DESIGN.md` · `ER_DIAGRAM.md` · `SCHEMA_OPEN_QUESTIONS.md` | Design, diagram, open decisions. |
| `database/INTEGRATION_PLAN.md` · `MEMBER1_HANDOFF.md` | Integration plan; what the backend functionality must produce. |
| `database/tests/` | `run_tests.py` (disposable-PostgreSQL verification), `sql/` tests, `vectors.json`. |

No file here contains a password, key or connection string with credentials. **Do not commit any.** `.env` files are git-ignored.

## 0. Verify locally first (no Supabase needed)

Needs PostgreSQL server binaries (`initdb`, `postgres`, `psql`, `pg_ctl`) and Python 3.9+. The runner starts a throw-away cluster in a temp directory on a random loopback port, emulates a worst-case Supabase (default privileges that auto-grant new objects to the API roles; empty `search_path` during migration), and deletes everything afterwards. It never connects anywhere else.

```bash
python database/tests/run_tests.py --pg-bin "C:/Program Files/PostgreSQL/17/bin"
# expected last line:  58/58 checks passed
```
**Run this against PostgreSQL 17.x binaries before deploying.** The suite has so far only run on 18.6 (the only version installed here). Install 17 side by side with 18 (it uses its own folder; it does not touch your running service), for example `winget install PostgreSQL.PostgreSQL.17` (choose a different port than your existing server during setup, or install the zip distribution), then:
```bash
python database/tests/run_tests.py --pg-bin "C:/Program Files/PostgreSQL/17/bin"
```
The runner uses its own temporary data directory and random port, so it never interferes with any PostgreSQL service you have running.

## 1. Apply to Supabase (when you decide to; this has NOT been done)

Supabase CLI is the supported path: it records each applied file in `supabase_migrations.schema_migrations`, so re-running `db push` skips applied files and never applies one twice.

Replace `<PROJECT_REF>` with your project reference id (Dashboard → Project Settings → General). Run from the repository root.

```bash
npx supabase --version
npx supabase login
npx supabase init                              # ONLY if supabase/config.toml does not exist; it does not touch migrations
npx supabase link --project-ref <PROJECT_REF>  # prompts for the database password; never put it in a file
npx supabase migration list                    # remote column must be empty for these five
npx supabase db push --dry-run                 # lists what WOULD be applied; changes nothing
npx supabase db push                           # applies in filename order; each file is atomic
npx supabase migration list                    # all five now applied
```
Expected, in order:
```
20261119120000_p0_foundation_ingestion.sql
20261119120100_p0_cases_assessments_evidence.sql
20261119120200_p1_reports_decisions.sql
20261119120300_p1_investigation.sql
20261119120400_p2_adversarial.sql
```
Each file is atomic: if it fails, nothing from that file is kept; fix and re-run `db push`. Re-running the same file by hand (outside tracking) fails safely at `CREATE SCHEMA soc` / `CREATE TABLE` ("already exists"): it never modifies existing data.

**SQL Editor is NOT recommended** (not tracked, and each file must be wrapped in `BEGIN; ... COMMIT;` by you because the files contain no transaction control). If you use it anyway, paste one file at a time inside `BEGIN; … COMMIT;`, then tell the CLI so it does not re-apply: `npx supabase migration repair --status applied <VERSION>` for each applied file version (`20261119120000` etc.).

## 2. Post-deploy audit (read-only)

```bash
psql "<DIRECT_OR_POOLER_CONNECTION_AS_postgres>" -f database/audit/post_deploy_audit.sql
```
or paste `database/audit/post_deploy_audit.sql` into the SQL Editor and run. Required: **no row with status FAIL.** `INFO` rows need a human look (row 15 tells you whether your admin role can read `soc` tables; row 6 tells you whether `soc` is exposed through the Data API).

## 3. Set the backend password (do not use the SQL Editor for this)

The migrations create `soc_api` and `soc_readonly` **without a password**, so they cannot log in. Setting a password through a SQL statement can leave it in plain text in the editor history and logs; use the client-side hashing of psql instead (the password is typed at a hidden prompt and sent already hashed):

```bash
psql "postgresql://postgres.<PROJECT_REF>@<POOLER_HOST>:5432/postgres?sslmode=require"   # prompts for the postgres password
postgres=> \password soc_api
postgres=> \q
```
Alternatively Dashboard → Database → Roles → `soc_api` → edit → set password. Use a long random password; store it only in your secret manager / the backend's environment. Leave `soc_readonly` without a password unless you actually need it.

## 4. Confirm the Data API does not expose `soc`

1. Dashboard → Project Settings → API → *Exposed schemas* must NOT contain `soc` (leave `public`, `graphql_public`).
2. The audit's row 6 reads the same setting from the database (`authenticator` role, `pgrst.db_schemas`).
3. Live check with the public anon key (it is a public client key; do not share the service key). Expected: an error that the schema is not exposed (`PGRST106`) and **no data**:
```bash
curl -s -H "apikey: <ANON_KEY>" -H "Accept-Profile: soc" "https://<PROJECT_REF>.supabase.co/rest/v1/datasets?limit=1"
```
Even if `soc` were exposed by mistake, `anon` / `authenticated` / `service_role` hold no privilege on it (the audit's row 5 verifies this), so the request would still be refused.

## 5. Connection check for the backend role

Use the exact connection method the backend will use (placeholders only; never commit real values):

```text
# session-mode pooler (IPv4 friendly; recommended for a long-running FastAPI service)
DATABASE_URL=postgresql+psycopg://soc_api.<PROJECT_REF>:<SOC_API_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=require
# direct connection (IPv6 unless you have the IPv4 add-on)
DATABASE_URL=postgresql+psycopg://soc_api:<SOC_API_PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres?sslmode=require
# transaction-mode pooler (port 6543): works, but disable prepared statements (psycopg: prepare_threshold=None)
```
```bash
psql "postgresql://soc_api.<PROJECT_REF>@<POOLER_HOST>:5432/postgres?sslmode=require" \
  -c "select current_user, current_setting('lock_timeout'), current_setting('statement_timeout')" \
  -c "select count(*) from soc.datasets" \
  -c "delete from soc.datasets"
# expect: soc_api | 10s | 30s ;  count 0 ;  the DELETE must fail with 'permission denied for table datasets'
```
If login is refused: the password was not set (§3), the username lacks the `.<PROJECT_REF>` suffix (pooler only), the direct host needs IPv6, or the pooler pool size exceeds the role's connection limit (20): keep the pooler pool size at or below 20 for this role.

## 6. If you must start over (empty project only)

The migrations have no "down" scripts on purpose (the schema is evidence storage; the application cannot delete anything). On a **throw-away** project you can discard everything manually; this destroys all stored evidence and is not part of any migration:
```sql
-- DANGER: only on a project with no data you need
DROP SCHEMA soc CASCADE;  DROP ROLE soc_api;  DROP ROLE soc_readonly;
-- then clear the remote history:  npx supabase migration repair --status reverted <VERSION>   (for each version)
```

## 7. Changing the schema later
Add a **new** migration (`npx supabase migration new <name>`); never edit an applied one. For every new table call `SELECT soc.secure_table('soc.<table>')` and end the file with `SELECT soc.lock_down_schema();`. Add the table to `database/tests/sql/08_security.sql` and re-run the suite and the audit.
