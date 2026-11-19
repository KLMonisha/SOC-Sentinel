# SOC Sentinel database

PostgreSQL schema for Supabase project `soc-sentinel` (PostgreSQL 17). Accessed **only** by the FastAPI backend; the frontend never connects to it.

| Path | What |
|---|---|
| `supabase/migrations/*.sql` | The five migrations. **Single source of truth** for the schema (Supabase CLI format). |
| `database/optional/*.sql` | Optional counterfactual-audit tables. Not applied unless you copy the file into `supabase/migrations/`. |
| `database/SCHEMA_DESIGN.md` | Design, per-table spec, security model, transaction protocol, verification status. |
| `database/ER_DIAGRAM.md` | Mermaid ER diagram. |
| `database/SCHEMA_OPEN_QUESTIONS.md` | Decisions and what still depends on Member 1 / you. |
| `database/INTEGRATION_PLAN.md` | Backend ↔ PostgreSQL ↔ frontend mappings, SQLAlchemy layout, transaction/connection strategy, integration order. |
| `database/MEMBER1_HANDOFF.md` | What the backend functionality must produce so the database accepts it. |
| `database/tests/` | `run_tests.py` (disposable-PostgreSQL verification), `sql/` tests, `vectors.json` (id reference vectors). |

Nothing in this folder contains a password, key or connection string with credentials. **Do not commit any.** `.env` files are git-ignored.

## 1. Verify locally first (no Supabase needed)

Needs PostgreSQL server binaries (`initdb`, `postgres`, `psql`, `pg_ctl`) and Python 3.9+; no packages to install. The runner starts a throw-away cluster in a temp directory on a random loopback port and deletes it afterwards. It never connects anywhere else.

```bash
python database/tests/run_tests.py --pg-bin "C:/Program Files/PostgreSQL/17/bin"
# expected last line:  42/42 checks passed
```
Use a **17.x** `--pg-bin` if you have one (Supabase runs 17; the suite was developed on 18.6 because that was installed). `--no-supabase-stubs` runs against plain PostgreSQL without Supabase's built-in roles (skips the one test file that needs them).

## 2. Apply to Supabase (when you decide to; this has NOT been done)

### Option A: Supabase CLI (recommended; records applied migrations)
Run from the repository root (`C:\Users\Priyanka\SOC-Sentinel`). Replace `<PROJECT_REF>` with your project's reference id (Dashboard → Project Settings → General).

```bash
npx supabase --version                       # downloads the CLI on first use
npx supabase login                           # opens the browser / asks for an access token

# only if supabase/config.toml does not exist yet (it will not touch supabase/migrations):
npx supabase init

npx supabase link --project-ref <PROJECT_REF>   # asks for the database password; do not put it in a file

npx supabase migration list                  # compare local vs remote (remote should be empty for these)
npx supabase db push --dry-run               # prints the migrations that WOULD be applied; changes nothing
npx supabase db push                         # applies them, in filename order, one transaction per file
npx supabase migration list                  # all five should now show as applied
```
Expected migrations, in order:
```
20261119120000_p0_foundation_ingestion.sql
20261119120100_p0_cases_assessments_evidence.sql
20261119120200_p1_reports_decisions.sql
20261119120300_p1_investigation.sql
20261119120400_p2_adversarial.sql
```
All are non-destructive (no DROP/TRUNCATE/DELETE/CASCADE) and use no extensions. If one fails, its transaction rolls back; fix and re-run `db push` (already-applied files are skipped).

### Option B: SQL Editor (no CLI)
Dashboard → SQL Editor → New query. Paste **one file at a time, in the order above**, and Run. Each file is a single transaction when run as one query. You must not run a file twice.

## 3. After applying (manual steps)

Run these in the SQL Editor as the `postgres` user. **Choose strong passwords and keep them out of the repo.**

```sql
-- 3a. Give the backend roles passwords (the migrations create them WITHOUT one, so they cannot log in yet)
ALTER ROLE soc_api      WITH PASSWORD '<generate-a-long-random-password>';
ALTER ROLE soc_readonly WITH PASSWORD '<another-long-random-password>';
```
```sql
-- 3b. Sanity checks (read-only)
SELECT count(*) AS soc_tables FROM pg_tables WHERE schemaname = 'soc';                       -- expect 22
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='soc' AND c.relkind='r' ORDER BY 1;                                          -- all true / true
SELECT rolname, rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname IN ('postgres','soc_api','soc_readonly');
-- expect soc_api / soc_readonly: bypassrls=false, super=false, canlogin=true.
-- NOTE the value for 'postgres': the admin role must have bypassrls=true to read soc tables (FORCE RLS). See SCHEMA_OPEN_QUESTIONS C2.
SELECT has_schema_privilege('anon','soc','USAGE') AS anon_usage, has_schema_privilege('authenticated','soc','USAGE') AS auth_usage;  -- both false
```
```text
3c. Dashboard → Project Settings → API → "Exposed schemas": make sure `soc` is NOT listed (leave public/graphql_public as they are).
    Do not enable the Data API for this schema, and do not create Supabase client keys for the frontend.
```

## 4. Connection strings for the backend (placeholders only)

Put these in the backend's environment or secret manager, never in git. Copy the host/port from Dashboard → Connect.

```text
# direct connection (IPv6 unless you have the IPv4 add-on)
DATABASE_URL=postgresql+psycopg://soc_api:<SOC_API_PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres?sslmode=require

# session-mode pooler (IPv4 friendly; recommended for a long-running FastAPI service)
DATABASE_URL=postgresql+psycopg://soc_api.<PROJECT_REF>:<SOC_API_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=require

# transaction-mode pooler (port 6543): works, but disable client-side prepared statements (psycopg: prepare_threshold=None)
```
The backend role name is **`soc_api`** (with the `.<PROJECT_REF>` suffix only on the pooler). Never use the `postgres` or `service_role` credentials in the backend.

## 5. If you must start over (empty project only)

The migrations have no "down" scripts on purpose (the schema is evidence storage and nothing in it can be deleted by the application). On a **throw-away** project you can discard everything with a manual statement; this destroys all stored evidence and is not part of any migration:
```sql
-- DANGER: only on a project with no data you need
DROP SCHEMA soc CASCADE;  DROP ROLE soc_api;  DROP ROLE soc_readonly;
-- then clear the remote history, e.g.  npx supabase migration repair --status reverted <version>  for each version
```

## 6. Changing the schema later
Add a **new** migration file with a later timestamp (`npx supabase migration new <name>`). Never edit an applied migration. Call `SELECT soc.secure_table('soc.<new_table>')` for every new table so it gets RLS, grants, policies and append-only triggers, and add it to `database/tests/sql/08_security.sql` (the suite checks that every table in `soc` is locked down).
