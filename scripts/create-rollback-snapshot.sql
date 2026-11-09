-- ATOMIC, LOCKED pre-deployment snapshot (the rollback substrate). Replaces the earlier prose
-- sequence, whose three autocommit CREATEs held no lock: a straggler generation could commit BETWEEN the
-- snapshot statements (partly included) or begin before meta's snapshot_at and commit after it with an
-- older committed_at, escaping a timestamp-based membership test. This script:
--   * runs in ONE transaction,
--   * holds the SAME per-account advisory lock as the decision RPCs (a concurrent generation commit
--     BLOCKS until the snapshot commits, so the snapshot is internally consistent),
--   * requires ZERO pending/running syncs for the account (belt on top of paused cron - and checked
--     BEFORE the schema upgrade is allowed to sweep such rows into 'failed'),
--   * captures the GENERATION ID SET + current heads explicitly (rollback membership is decided by
--     ABSENCE from this set, never by committed_at comparison).
--
-- Rehearsed through the ACTUAL psql invocation by tests/db/integration/rollback-rehearsal.test.ts,
-- including a concurrent-RPC lock-window proof.
--
-- Usage (psql):
--   psql "$DB_URL" -v account="'<ad_account_uuid>'" -f scripts/create-rollback-snapshot.sql

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE _snap_params ON COMMIT DROP AS SELECT :account::uuid AS account;

SELECT pg_advisory_xact_lock(hashtext((SELECT account FROM _snap_params)::text || ':decision'));

CREATE SCHEMA IF NOT EXISTS rollback;
REVOKE ALL ON SCHEMA rollback FROM PUBLIC;

DO $$
DECLARE v_acct uuid;
BEGIN
  SELECT account INTO v_acct FROM pg_temp._snap_params;

  -- Precondition: no sync may be in flight for this account. (Also verify this BEFORE applying
  -- a schema upgrade that marks pending/running rows failed and could hide a live old process.)
  IF EXISTS (SELECT 1 FROM public.api_sync_logs
             WHERE ad_account_id = v_acct AND status IN ('pending','running')) THEN
    RAISE EXCEPTION 'snapshot aborted: pending/running sync rows exist for account % - pause triggers and resolve them first', v_acct;
  END IF;

  EXECUTE 'DROP TABLE IF EXISTS rollback.meta';
  EXECUTE 'DROP TABLE IF EXISTS rollback.flags_snapshot';
  EXECUTE 'DROP TABLE IF EXISTS rollback.recommendations_snapshot';
  EXECUTE 'DROP TABLE IF EXISTS rollback.generations_snapshot';

  EXECUTE format('CREATE TABLE rollback.meta AS SELECT now() AS snapshot_at, %L::uuid AS account', v_acct);
  -- ALL account flags, not only active ones: the RPC''s ON CONFLICT can REACTIVATE and mutate a
  -- previously INACTIVE same-day row - an active-only snapshot could not restore its original fields or
  -- its inactive state. Each row''s captured is_active is restored verbatim by the rollback script.
  EXECUTE format('CREATE TABLE rollback.flags_snapshot AS SELECT * FROM public.flags WHERE ad_account_id = %L::uuid', v_acct);
  EXECUTE format('CREATE TABLE rollback.recommendations_snapshot AS SELECT id, status FROM public.recommendations WHERE ad_account_id = %L::uuid', v_acct);
  -- The durable membership boundary: every generation that exists AT SNAPSHOT TIME, with its head state.
  EXECUTE format('CREATE TABLE rollback.generations_snapshot AS SELECT id, kind, is_current FROM public.decision_generations WHERE ad_account_id = %L::uuid', v_acct);
END $$;

COMMIT;
