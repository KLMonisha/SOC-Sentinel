# Verified database connection (DB3)

Verified on 2026-11-19 against Supabase PostgreSQL 17.12, project `soc-sentinel`. No credentials appear here.

## Connection
| Item | Value |
|---|---|
| Method | Session-mode pooler (Supavisor), TLS required (`sslmode=require`) |
| Host | `aws-0-ap-southeast-2.pooler.supabase.com` |
| Port | `5432` (session). `6543` is transaction mode, not used |
| Database | `postgres` |
| Username | `soc_api.<PROJECT_REF>` (project ref `sxwlxerqksjbxjghgyqj`; the suffix is mandatory on the pooler) |
| Password | Set with `\password soc_api` in psql; stored only in the password manager and the backend local `.env` |
| Template | `database/.env.example` |

## What was verified, and how
| Check | Result | Evidence |
|---|---|---|
| `soc_api` authenticates through the session pooler | Pass | Manual psql login |
| `SELECT` on the private `soc` schema | Pass | Manual query |
| `DELETE FROM soc.datasets WHERE FALSE` | Refused: permission denied for table datasets | Manual; rolled back |
| `soc` not exposed to the Data API; no privilege for anon/authenticated/service_role | Pass | Post-deploy audit rows 5 and 6 (during DB2) |
| No UPDATE/DELETE/TRUNCATE grant on any soc table; SELECT and INSERT on all | Pass | Post-deploy audit rows 9 and 10 (catalog check, not a manual attempt) |
| Role timeouts: statement 30s, lock 10s, idle-in-transaction 60s; connection limit 20; no superuser/BYPASSRLS | Pass | Post-deploy audit rows 7 and 8 |

Not manually attempted against live data: UPDATE and TRUNCATE statements, and reading the timeouts through the pooler session. Optional one-off check (changes nothing):
`select current_setting('statement_timeout'), current_setting('lock_timeout'); begin; update soc.datasets set dataset_id = dataset_id where false; rollback;` (UPDATE must be refused).

## Rules for the backend
* Use only the `soc_api` URL. Never the `postgres` password, service-role key or anon key.
* Never call `create_all`; map SQLAlchemy models to the existing `soc` schema (set `search_path` or schema-qualify).
* Keep pool size well under 20 connections.
* Retry on SQLSTATE 55P03, 57014, 40001, 40P01 with the same idempotency key. Error mapping: `MEMBER1_HANDOFF.md` section C.

## Remaining dependencies
See `INTEGRATION_PLAN.md`, and `MEMBER1_HANDOFF.md` sections A and B. Backend must install `psycopg[binary]` (not yet in `requirements.txt`).
