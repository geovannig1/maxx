-- EXECUTABLE rollback-to-snapshot for the durable-generation deployment.
-- Rehearsed through the ACTUAL psql invocation by tests/db/integration/rollback-rehearsal.test.ts.
--
-- SEMANTICS (changed from an earlier single-generation form): this restores the account's decision
-- state to the pre-deployment SNAPSHOT (runbook step: taken AFTER migrations, BEFORE code deploy) and
-- durably stamps EVERY generation committed since the snapshot as rolled back. Stamped generations keep
-- their rows (auditability) but are excluded by every date-scoped reader via rolled_back_at (migration
-- 048) - demoting is_current alone is NOT enough because lineage/report readers order by committed_at.
--
-- WHY snapshot-driven: reactivating rows by superseded_by_generation_id would restore predecessors
-- ALONGSIDE newly written rows and produce conflicting active decisions. Set-reconciliation against the
-- snapshot restores EXACTLY the pre-deployment state, including every MUTABLE column a same-day upsert
-- can change (confidence, reason, evidence, action, watch_next, metrics, audience) - not just activation.
--
-- PRECONDITIONS (the script aborts loudly if violated):
--   1. Cron/manual syncs are PAUSED; the script also takes the RPCs' advisory lock.
--   2. The locked snapshot exists, created ATOMICALLY by scripts/create-rollback-snapshot.sql
--      (one transaction, same advisory lock, zero-active-sync precondition, and the explicit
--      generations_snapshot ID set + heads this script keys on). Runbook: run it AFTER the schema
--      upgrade, BEFORE the code deploy. The schema is NOT API-exposed and carries no grants.
--   3. No NEW work exists after a PRIOR rollback (guarded): a resumed system's generations must never be
--      destroyed by re-running an obsolete snapshot restore.
--
-- PARAMETERS are materialized in a TEMP table OUTSIDE any dollar-quoted body - psql does NOT substitute
-- :variables inside DO $$ ... $$ (an earlier version of this script failed exactly there).
--
-- Usage (psql):
--   psql "$DB_URL" \
--     -v account="'<ad_account_uuid>'" \
--     -v confirm="'ROLLBACK-ALL-SINCE-SNAPSHOT'" \
--     -f scripts/rollback-flag-generation.sql
--
-- REPORTS: daily_reports pinned to rolled-back rec generations are LEFT STANDING (prior-report
-- doctrine); a NOTICE lists them for manual review. After rollback, date-scoped readers resolve lineage
-- against the restored (non-rolled-back) generations.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE _rb_params ON COMMIT DROP AS
  SELECT :account::uuid AS account, :confirm::text AS confirm;

SELECT pg_advisory_xact_lock(hashtext((SELECT account FROM _rb_params)::text || ':decision'));

DO $$
DECLARE
  v_acct uuid;
  v_confirm text;
  v_snapshot_at timestamptz;
  v_gen record;
  v_prior_rollback timestamptz;
  v_pinned int;
BEGIN
  SELECT account, confirm INTO v_acct, v_confirm FROM pg_temp._rb_params;

  -- Guard 0: explicit operator intent.
  IF v_confirm IS DISTINCT FROM 'ROLLBACK-ALL-SINCE-SNAPSHOT' THEN
    RAISE EXCEPTION 'rollback aborted: confirm token missing/mismatched (pass -v confirm="''ROLLBACK-ALL-SINCE-SNAPSHOT''")';
  END IF;

  -- Guard 0b: NO in-flight sync. The advisory lock serializes generation RPC transactions, but
  -- NOT a runDailySync that has not reached its RPC yet - paused triggers stop NEW jobs, not one already
  -- executing. Such a sync could resume after this rollback and immediately publish fresh decision state
  -- over the restored one. Abort until the account shows zero pending/running sync rows.
  IF EXISTS (SELECT 1 FROM public.api_sync_logs
             WHERE ad_account_id = v_acct AND status IN ('pending','running')) THEN
    RAISE EXCEPTION 'rollback aborted: pending/running sync rows exist for account % - wait for or resolve the in-flight sync first', v_acct;
  END IF;

  -- Guard 1: snapshot artifacts exist and belong to this account (created atomically by
  -- scripts/create-rollback-snapshot.sql - incl. the generation ID SET that defines membership).
  IF to_regclass('rollback.meta') IS NULL
     OR to_regclass('rollback.flags_snapshot') IS NULL
     OR to_regclass('rollback.recommendations_snapshot') IS NULL
     OR to_regclass('rollback.generations_snapshot') IS NULL THEN
    RAISE EXCEPTION 'rollback aborted: rollback snapshot artifacts missing (run scripts/create-rollback-snapshot.sql first)';
  END IF;
  SELECT snapshot_at INTO v_snapshot_at FROM rollback.meta WHERE account = v_acct;
  IF v_snapshot_at IS NULL THEN
    RAISE EXCEPTION 'rollback aborted: rollback.meta has no snapshot for account %', v_acct;
  END IF;

  -- Guard 2: never destroy post-rollback recovery work with a STALE snapshot. A snapshot taken BEFORE
  -- the latest rollback predates recovered state - restoring it would roll back the recovery itself.
  -- A snapshot taken AFTER the latest rollback is fresh and proceeds.
  SELECT max(rolled_back_at) INTO v_prior_rollback FROM public.decision_generations
    WHERE ad_account_id = v_acct AND rolled_back_at IS NOT NULL;
  IF v_prior_rollback IS NOT NULL AND v_snapshot_at < v_prior_rollback THEN
    RAISE EXCEPTION 'rollback aborted: the snapshot (%) predates the latest rollback (%) - it is obsolete; take a fresh snapshot or re-derive', v_snapshot_at, v_prior_rollback;
  END IF;

  -- (1) STAMP every post-snapshot generation as rolled back (kept for audit; excluded by all readers).
  -- Membership is decided by ABSENCE FROM THE SNAPSHOT'S GENERATION ID SET - never by
  -- committed_at comparison, which an interleaving or long-running transaction could evade.
  FOR v_gen IN
    SELECT id, kind, reference_date FROM public.decision_generations dg
    WHERE dg.ad_account_id = v_acct AND dg.rolled_back_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM rollback.generations_snapshot s WHERE s.id = dg.id)
    ORDER BY dg.committed_at
  LOOP
    RAISE NOTICE 'rolling back % generation % (reference_date %)', v_gen.kind, v_gen.id, v_gen.reference_date;
    UPDATE public.decision_generations SET rolled_back_at = now(), is_current = false WHERE id = v_gen.id;
  END LOOP;

  -- (2) FLAGS: restore EVERY mutable column of every snapshot row (a same-day upsert can change all of
  -- these; natural-key and immutable columns are untouched by design).
  UPDATE public.flags f SET
    is_active = s.is_active,
    superseded_at = s.superseded_at,
    superseded_reason = s.superseded_reason,
    superseded_by_generation_id = s.superseded_by_generation_id,
    generation_id = s.generation_id,
    confidence = s.confidence,
    audience_type = s.audience_type,
    reason = s.reason,
    evidence = s.evidence,
    recommended_action = s.recommended_action,
    watch_next = s.watch_next,
    spend_in_window = s.spend_in_window,
    cpa_in_window = s.cpa_in_window,
    ctr_in_window = s.ctr_in_window,
    frequency_in_window = s.frequency_in_window
  FROM rollback.flags_snapshot s
  WHERE f.id = s.id AND f.ad_account_id = v_acct;

  -- (3) FLAGS: retire everything active that was NOT active pre-deployment (post-snapshot additions).
  UPDATE public.flags f
    SET is_active = false, superseded_at = now(), superseded_reason = NULL, superseded_by_generation_id = NULL
    WHERE f.ad_account_id = v_acct AND f.is_active
      AND NOT EXISTS (SELECT 1 FROM rollback.flags_snapshot s WHERE s.id = f.id);

  -- (4) RECOMMENDATIONS: restore each snapshot row's status (reopens the previously-open set the bad
  -- generations superseded), then supersede open rows that did not exist pre-deployment.
  UPDATE public.recommendations r SET status = s.status
    FROM rollback.recommendations_snapshot s
    WHERE r.id = s.id AND r.ad_account_id = v_acct;
  UPDATE public.recommendations r SET status = 'superseded'
    WHERE r.ad_account_id = v_acct AND r.status = 'open'
      AND NOT EXISTS (SELECT 1 FROM rollback.recommendations_snapshot s WHERE s.id = r.id);

  -- (5) HEADS: restore is_current EXACTLY as captured in the snapshot (explicit, not inferred
  -- from committed_at ordering). Stamped generations already lost is_current in step (1).
  UPDATE public.decision_generations dg SET is_current = s.is_current
    FROM rollback.generations_snapshot s
    WHERE dg.id = s.id AND dg.ad_account_id = v_acct AND dg.is_current IS DISTINCT FROM s.is_current;

  -- (6) REPORTS: surface (never mutate) reports pinned to rolled-back rec generations.
  SELECT count(*) INTO v_pinned FROM public.daily_reports d
    WHERE d.ad_account_id = v_acct AND d.recommendation_generation_id IN (
      SELECT id FROM public.decision_generations
      WHERE ad_account_id = v_acct AND kind = 'recommendation' AND rolled_back_at IS NOT NULL);
  IF v_pinned > 0 THEN
    RAISE NOTICE 'rollback: % daily_report(s) are pinned to rolled-back rec generation(s) - review manually (prior-report doctrine: they stand; lineage readers now resolve against restored generations)', v_pinned;
  END IF;
END $$;

COMMIT;
