-- SOC Sentinel: read-only post-deployment audit.
-- Run AFTER applying the migrations (Supabase SQL Editor as `postgres`, or psql). It changes nothing.
-- Every row is PASS, FAIL or INFO. Any FAIL means: do not point the backend at this database yet.
-- Uses only pg_catalog; needs no superuser and no extension. The test suite runs this exact file.

WITH
soc_tables AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'soc' AND c.relkind = 'r'
),
api_roles AS (SELECT * FROM pg_roles WHERE rolname = 'soc_api'),
ro_roles  AS (SELECT * FROM pg_roles WHERE rolname = 'soc_readonly'),
leaks AS (   -- any privilege on the soc schema or on ANY object in it for PUBLIC or the Supabase API roles
  SELECT 'schema' AS kind, n.nspname::text AS obj,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type::text AS priv
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
   WHERE n.nspname = 'soc'
  UNION ALL
  SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' ELSE 'table' END, c.relname::text,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault((CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
   WHERE n.nspname = 'soc' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL
  SELECT 'function', p.proname::text,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, a.privilege_type::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
   WHERE n.nspname = 'soc'
),
api_leaks AS (SELECT * FROM leaks WHERE grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')),
exposed AS (  -- PostgREST (Supabase Data API) schema list lives on the authenticator role
  SELECT c AS cfg FROM pg_roles r, LATERAL unnest(r.rolconfig) c WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%'
)
SELECT check_name, status, detail FROM (
  SELECT 1 AS o, 'server version' AS check_name, 'INFO' AS status, current_setting('server_version') || CASE WHEN current_setting('server_version_num')::int >= 170000 THEN ' (>= 17)' ELSE ' (older than the 17 target)' END AS detail
  UNION ALL SELECT 2, 'database encoding', CASE WHEN pg_encoding_to_char(encoding) = 'UTF8' THEN 'PASS' ELSE 'INFO' END,
         pg_encoding_to_char(encoding) || ' (SHA-256 of raw_text is computed over UTF-8 bytes either way)' FROM pg_database WHERE datname = current_database()
  UNION ALL SELECT 3, 'soc tables present', CASE WHEN (SELECT count(*) FROM soc_tables) >= 22 THEN 'PASS' ELSE 'FAIL' END, (SELECT count(*) FROM soc_tables)::text || ' tables (expected 22 core)'
  UNION ALL SELECT 4, 'RLS enabled and forced on every soc table', CASE WHEN NOT EXISTS (SELECT 1 FROM soc_tables WHERE NOT (relrowsecurity AND relforcerowsecurity)) THEN 'PASS' ELSE 'FAIL' END,
         coalesce((SELECT string_agg(relname, ', ') FROM soc_tables WHERE NOT (relrowsecurity AND relforcerowsecurity)), 'all tables')
  UNION ALL SELECT 5, 'no privilege on soc for PUBLIC / anon / authenticated / service_role', CASE WHEN NOT EXISTS (SELECT 1 FROM api_leaks) THEN 'PASS' ELSE 'FAIL' END,
         coalesce((SELECT string_agg(DISTINCT kind || ' ' || obj || ' -> ' || grantee || ' ' || priv, '; ') FROM api_leaks), 'none')
  UNION ALL SELECT 6, 'soc is not an exposed PostgREST (Data API) schema',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN 'INFO'
              WHEN EXISTS (SELECT 1 FROM exposed WHERE cfg ~ '(=|,)\s*soc\s*(,|$)') THEN 'FAIL' ELSE 'PASS' END,
         coalesce((SELECT cfg FROM exposed), CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN 'authenticator has no pgrst.db_schemas setting (PostgREST default applies; confirm in the dashboard API settings)' ELSE 'no authenticator role: not a Supabase database' END)
  UNION ALL SELECT 7, 'soc_api role attributes', CASE WHEN EXISTS (SELECT 1 FROM api_roles WHERE rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolconnlimit > 0) THEN 'PASS' ELSE 'FAIL' END,
         coalesce((SELECT format('login=%s super=%s bypassrls=%s createdb=%s createrole=%s connlimit=%s', rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolconnlimit) FROM api_roles), 'role missing')
  UNION ALL SELECT 8, 'soc_api timeouts set', CASE WHEN EXISTS (SELECT 1 FROM api_roles WHERE rolconfig @> ARRAY['statement_timeout=30s'] AND rolconfig @> ARRAY['lock_timeout=10s'] AND rolconfig @> ARRAY['idle_in_transaction_session_timeout=60s']) THEN 'PASS' ELSE 'FAIL' END,
         coalesce((SELECT array_to_string(rolconfig, ', ') FROM api_roles), 'role missing')
  UNION ALL SELECT 9, 'soc_api cannot UPDATE / DELETE / TRUNCATE any soc table', CASE WHEN NOT EXISTS (SELECT 1 FROM soc_tables t WHERE has_table_privilege('soc_api', t.oid, 'UPDATE') OR has_table_privilege('soc_api', t.oid, 'DELETE') OR has_table_privilege('soc_api', t.oid, 'TRUNCATE')) THEN 'PASS' ELSE 'FAIL' END, 'append-only'
  UNION ALL SELECT 10, 'soc_api can SELECT and INSERT every soc table', CASE WHEN NOT EXISTS (SELECT 1 FROM soc_tables t WHERE NOT (has_table_privilege('soc_api', t.oid, 'SELECT') AND has_table_privilege('soc_api', t.oid, 'INSERT'))) THEN 'PASS' ELSE 'FAIL' END, 'read + insert'
  UNION ALL SELECT 11, 'soc_readonly role attributes', CASE WHEN EXISTS (SELECT 1 FROM ro_roles WHERE NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND rolconfig @> ARRAY['default_transaction_read_only=on']) THEN 'PASS' ELSE 'FAIL' END, 'read-only'
  UNION ALL SELECT 12, 'append-only triggers on every soc table', CASE WHEN NOT EXISTS (SELECT 1 FROM soc_tables t WHERE (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid = t.oid AND g.tgname IN ('trg_append_only', 'trg_no_truncate')) <> 2) THEN 'PASS' ELSE 'FAIL' END, 'UPDATE/DELETE/TRUNCATE blocked'
  UNION ALL SELECT 13, 'SHA-256 smoke test (known vector for "abc")', CASE WHEN soc.sha256_hex('abc') = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN 'PASS' ELSE 'FAIL' END, soc.sha256_hex('abc')
  UNION ALL SELECT 14, 'id derivation smoke test', CASE WHEN soc.derive_dataset_id(repeat('a', 64)) = 'ds_aaaaaaaaaaaaaaaa'
              AND soc.derive_event_id('ds_x', 'f.csv', 2, repeat('b', 64)) = 'evt_' || left(soc.sha256_hex('ds_x' || chr(31) || 'f.csv' || chr(31) || '2' || chr(31) || repeat('b', 64)), 16) THEN 'PASS' ELSE 'FAIL' END, 'derive_* match the documented formulas'
  UNION ALL SELECT 15, 'admin role BYPASSRLS (needed to read soc tables under FORCE RLS)', CASE WHEN (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN 'PASS' ELSE 'INFO' END,
         'current_user=' || current_user || ' bypassrls=' || (SELECT rolbypassrls::text FROM pg_roles WHERE rolname = current_user) || ' (INFO = this role will see 0 rows in soc tables; use soc_readonly for admin reads)'
) q ORDER BY o;
