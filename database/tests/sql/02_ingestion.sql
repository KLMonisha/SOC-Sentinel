-- Datasets, upload history, dataset-scoped event ids, provenance integrity. Runs in a rolled-back transaction.
BEGIN;

-- ---------- dataset dedup + upload history (approved Q2)
DO $$
DECLARE ds text; sha text := soc.sha256_hex('file-bytes-A'); n integer;
BEGIN
  ds := soc_test.mk_dataset('file-bytes-A', 'auth_logs.csv');
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.check(ds = 'ds_' || left(sha, 16), 'dataset_id is derived from the file SHA-256');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets (dataset_id, file_sha256, canonical_filename, file_size_bytes, file_format, total_records, valid_events, quarantined_records)
     VALUES (%L, %L, 'again.csv', 10, 'csv', 1, 1, 0)$f$, ds, sha), '23505', 'identical bytes cannot create a second dataset');

  -- the same bytes uploaded again under another filename: history grows, dataset does not
  INSERT INTO soc.dataset_uploads (dataset_id, original_filename, was_duplicate) VALUES (ds, 'renamed_copy.csv', true);
  INSERT INTO soc.dataset_uploads (dataset_id, original_filename, was_duplicate) VALUES (ds, 'auth_logs.csv', true);
  SELECT count(*) INTO n FROM soc.dataset_uploads WHERE dataset_id = ds;
  PERFORM soc_test.check(n = 3, 'upload history keeps every upload (3 uploads, 1 dataset), including different filenames');
  PERFORM soc_test.check((SELECT count(*) FROM soc.datasets WHERE file_sha256 = sha) = 1, 'still exactly one dataset for those bytes');
  PERFORM soc_test.check((SELECT canonical_filename FROM soc.datasets WHERE dataset_id = ds) = 'auth_logs.csv', 'canonical filename is the first upload''s');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.dataset_uploads (dataset_id, original_filename, was_duplicate) VALUES (%L, 'x.csv', false)$f$, ds),
    '23505', 'only one non-duplicate (first) upload per dataset');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.dataset_uploads SET original_filename = 'tampered.csv' WHERE dataset_id = %L$f$, ds), 'SC100', 'upload history is append-only (UPDATE)');
  PERFORM soc_test.expect_error(format($f$DELETE FROM soc.dataset_uploads WHERE dataset_id = %L$f$, ds), 'SC100', 'upload history is append-only (DELETE)');
END $$;

DO $$
DECLARE sha text := soc.sha256_hex('orphan'); id text := soc.derive_dataset_id(soc.sha256_hex('orphan'));
BEGIN
  BEGIN
    INSERT INTO soc.datasets (dataset_id, file_sha256, canonical_filename, file_size_bytes, file_format, total_records, valid_events, quarantined_records)
    VALUES (id, sha, 'a.csv', 10, 'csv', 1, 1, 0);
    PERFORM soc_test.verify_deferred();
    RAISE EXCEPTION 'TEST FAILED: dataset without first upload was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'SC001' THEN RAISE EXCEPTION 'TEST FAILED: expected SC001, got % (%)', SQLSTATE, SQLERRM; END IF;
    RAISE NOTICE 'PASS: a dataset without a first upload is rejected at commit [SC001]';
  END;
END $$;

DO $$
DECLARE sha text := soc.sha256_hex('bad');
BEGIN
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets VALUES ('ds_wrong', %L, 'a.csv', 10, 'csv', 1, 1, 0, now())$f$, sha), '23514', 'dataset_id must be derived from file_sha256');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets VALUES (%L, 'XYZ', 'a.csv', 10, 'csv', 1, 1, 0, now())$f$, soc.derive_dataset_id('XYZ')), '23514', 'file_sha256 must be 64 lowercase hex');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets VALUES (%L, %L, '../evil.csv', 10, 'csv', 1, 1, 0, now())$f$, soc.derive_dataset_id(sha), sha), '23514', 'filenames with path separators are rejected');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets VALUES (%L, %L, 'a.csv', 10, 'csv', 5, 1, 0, now())$f$, soc.derive_dataset_id(sha), sha), '23514', 'counts must add up (valid + quarantined = total)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets VALUES (%L, %L, 'a.csv', 10485761, 'csv', 1, 1, 0, now())$f$, soc.derive_dataset_id(sha), sha), '23514', '10 MB size limit enforced');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets VALUES (%L, %L, 'a.xml', 10, 'xml', 1, 1, 0, now())$f$, soc.derive_dataset_id(sha), sha), '23514', 'only csv/json formats');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.datasets (dataset_id, file_sha256, file_size_bytes, file_format, total_records, valid_events, quarantined_records) VALUES (%L, %L, 10, 'csv', 1, 1, 0)$f$, soc.derive_dataset_id(sha), sha), '23502', 'canonical_filename is required');
END $$;

-- ---------- events: provenance + dataset-scoped stable ids
DO $$
DECLARE dsA text; dsB text; a1 text; b1 text; n integer; raw text; hash text;
BEGIN
  dsA := soc_test.mk_dataset('A-bytes'); dsB := soc_test.mk_dataset('B-bytes');   -- both canonical file auth_logs.csv
  a1 := soc_test.mk_event(dsA, 2); b1 := soc_test.mk_event(dsB, 2);                -- IDENTICAL row, same filename, same line, different dataset
  PERFORM soc_test.check(a1 <> b1, 'identical records in different datasets get different event ids (dataset-scoped)');
  PERFORM soc_test.check(a1 = soc.derive_event_id(dsA, 'auth_logs.csv', 2, (SELECT raw_sha256 FROM soc.source_events WHERE event_id = a1 AND dataset_id = dsA)), 'event id is reproducible from dataset, file, line and raw hash');
  PERFORM soc_test.check(a1 ~ '^evt_[0-9a-f]{16}$', 'event id has the evt_<16 hex> shape');
  PERFORM soc_test.check((SELECT count(*) FROM soc.source_events WHERE event_id IN (a1, b1)) = 2, 'both events stored side by side (composite key)');

  SELECT raw_text, raw_sha256 INTO raw, hash FROM soc.source_events WHERE dataset_id = dsA AND event_id = a1;
  PERFORM soc_test.check(raw <> '' AND hash = soc.sha256_hex(raw), 'raw_text is stored verbatim and raw_sha256 is its SHA-256');
  PERFORM soc_test.check((SELECT source_file || ':' || line_number FROM soc.source_events WHERE dataset_id = dsA AND event_id = a1) = 'auth_logs.csv:2', 'source_file and line_number preserved');

  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, %L, now(), 'x', 'failure', 'auth_logs.csv', 9, 'row', %L)$f$, dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 9, soc.sha256_hex('other')), soc.sha256_hex('other')),
    '23514', 'raw_sha256 that does not match raw_text is rejected');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, 'evt_0000000000000000', now(), 'x', 'failure', 'auth_logs.csv', 9, 'row', %L)$f$, dsA, soc.sha256_hex('row')), '23514', 'event_id that is not the derived id is rejected');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, %L, now(), 'x', 'failure', 'auth_logs.csv', 2, 'dup', %L)$f$, dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 2, soc.sha256_hex('dup')), soc.sha256_hex('dup')),
    '23505', '(dataset, source_file, line_number) is unique');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, %L, now(), 'x', 'weird', 'auth_logs.csv', 11, 'r11', %L)$f$, dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 11, soc.sha256_hex('r11')), soc.sha256_hex('r11')), '23514', 'outcome must be success/failure/unknown');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, %L, now(), 'x', 'failure', 'auth_logs.csv', 12, '', %L)$f$, dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 12, soc.sha256_hex('')), soc.sha256_hex('')), '23514', 'empty raw_text is rejected (no fabricated provenance)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, %L, NULL, 'x', 'failure', 'auth_logs.csv', 13, 'r13', %L)$f$, dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 13, soc.sha256_hex('r13')), soc.sha256_hex('r13')), '23502', 'timestamp is required');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES ('ds_missing0000000000', %L, now(), 'x', 'failure', 'auth_logs.csv', 14, 'r14', %L)$f$, soc.derive_event_id('ds_missing0000000000', 'auth_logs.csv', 14, soc.sha256_hex('r14')), soc.sha256_hex('r14')),
    '23503', 'events must reference an existing dataset (invalid reference rejected)');
  PERFORM soc_test.expect_error(format($f$UPDATE soc.source_events SET raw_text = 'tampered' WHERE dataset_id = %L$f$, dsA), 'SC100', 'evidence cannot be updated');
  PERFORM soc_test.expect_error(format($f$DELETE FROM soc.source_events WHERE dataset_id = %L$f$, dsA), 'SC100', 'evidence cannot be deleted');
  PERFORM soc_test.expect_error('TRUNCATE soc.source_events', '0A000', 'evidence cannot be truncated (referenced by foreign keys)');
  PERFORM soc_test.verify_deferred();
  PERFORM soc_test.expect_error('TRUNCATE soc.source_events CASCADE', 'SC100', 'TRUNCATE ... CASCADE is stopped by the append-only trigger');
  PERFORM soc_test.expect_error('TRUNCATE soc.quarantined_records', 'SC100', 'quarantine records cannot be truncated');
  PERFORM soc_test.expect_error(format($f$DELETE FROM soc.datasets WHERE dataset_id = %L$f$, dsA), 'SC100', 'datasets cannot be deleted');

  -- null parsed fields are representable, not forced
  INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256)
  VALUES (dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 20, soc.sha256_hex('{"k":1}')), now(), 'web_access', 'unknown', 'auth_logs.csv', 20, '{"k":1}', soc.sha256_hex('{"k":1}'));
  PERFORM soc_test.check(true, 'an event with no username/ip/host/resource is accepted (missing stays missing)');

  -- legacy canonical-json hash is kept separately and never confused with raw_sha256
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256,canonical_json_sha256)
    VALUES (%L, %L, now(), 'x','failure','auth_logs.csv', 21, 'r21', %L, 'not-hex')$f$, dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 21, soc.sha256_hex('r21')), soc.sha256_hex('r21')), '23514', 'canonical_json_sha256, when present, must be 64 hex');
  INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,outcome,source_file,line_number,raw_text,raw_sha256,canonical_json_sha256,raw_record)
  VALUES (dsA, soc.derive_event_id(dsA, 'auth_logs.csv', 22, soc.sha256_hex('r22')), now(), 'x', 'failure', 'auth_logs.csv', 22, 'r22', soc.sha256_hex('r22'), soc.sha256_hex('legacy-canonical-json'), '{"user":"alice"}');
  PERFORM soc_test.check((SELECT canonical_json_sha256 <> raw_sha256 FROM soc.source_events WHERE dataset_id = dsA AND line_number = 22), 'legacy hash and original-record hash are distinct columns');
END $$;

-- ---------- bounds: generous enough for hostile/untrusted values to be STORED (the backend quarantines anything beyond them)
DO $$
DECLARE ds text := soc_test.mk_dataset('caps-bytes'); e text; raw text; sha text;
BEGIN
  raw := 'row-with-long-fields'; sha := soc.sha256_hex(raw);
  INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,username,source_ip,host,resource,outcome,source_file,line_number,raw_text,raw_sha256)
  VALUES (ds, soc.derive_event_id(ds,'auth_logs.csv',2,sha), now(), repeat('t',256), repeat('u',4096), repeat('i',4096), repeat('h',4096), repeat('r',8192), 'unknown', 'auth_logs.csv', 2, raw, sha);
  PERFORM soc_test.check(true, 'a 4096-character username / ip / host and 8192-character resource are stored (hostile values do not break ingestion)');
  raw := 'row-too-long'; sha := soc.sha256_hex(raw);
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.source_events (dataset_id,event_id,timestamp,event_type,username,outcome,source_file,line_number,raw_text,raw_sha256)
    VALUES (%L, %L, now(), 'x', %L, 'unknown', 'auth_logs.csv', 3, %L, %L)$f$, ds, soc.derive_event_id(ds,'auth_logs.csv',3,sha), repeat('u', 4097), raw, sha), '23514', 'beyond 4096 characters the database refuses (the backend must quarantine such rows)');
  INSERT INTO soc.quarantined_records (dataset_id, row_number, reason) VALUES (ds, 9, repeat('echoed bad value ', 1000));
  PERFORM soc_test.check(true, 'a long quarantine reason (error text echoing a bad value) is stored');
END $$;

-- ---------- quarantine
DO $$
DECLARE ds text := soc_test.mk_dataset('Q-bytes');
BEGIN
  INSERT INTO soc.quarantined_records (dataset_id, row_number, reason, raw_record) VALUES (ds, 4, 'invalid timestamp', '{"timestamp":"bad"}');
  INSERT INTO soc.quarantined_records (dataset_id, row_number, reason, raw_record) VALUES (ds, 5, 'not an object', '"plain string"');
  PERFORM soc_test.check(true, 'quarantined rows are stored with their raw record (object or not)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.quarantined_records (dataset_id, row_number, reason) VALUES (%L, 4, 'dup')$f$, ds), '23505', 'one quarantine row per (dataset, row_number)');
  PERFORM soc_test.expect_error(format($f$INSERT INTO soc.quarantined_records (dataset_id, row_number, reason) VALUES (%L, 0, 'zero')$f$, ds), '23514', 'row_number >= 1');
  PERFORM soc_test.expect_error($f$INSERT INTO soc.quarantined_records (dataset_id, row_number, reason) VALUES ('ds_nope0000000000', 1, 'x')$f$, '23503', 'quarantine must reference an existing dataset');
END $$;

ROLLBACK;
