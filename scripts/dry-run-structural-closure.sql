-- Deployment dry-run: list every ACTIVE flag that replace_flag_generation's structural (6b) and
-- orphan (6c) closures WOULD close for an account, WITHOUT changing anything. Run BEFORE applying
-- the durable-generation schema to production (runbook step 4) so the owner reviews the exact would-close set.
--
-- The predicates MIRROR the RPC exactly (a PGlite parity test asserts the id sets match on the same
-- fixture - tests/db/rpc-generations.test.ts 'dry-run parity'). Keep the two in lockstep.
--
-- Usage (psql):
--   psql "$DB_URL" -v account="'<ad_account_uuid>'" -v boundary="'<iso timestamp>'" \
--     -f scripts/dry-run-structural-closure.sql
--
-- CONCRETE boundary: use the latest SUCCESSFUL lifecycle sync's start instant --
--   SELECT started_at FROM api_sync_logs
--   WHERE ad_account_id = :account AND status = 'success' ORDER BY started_at DESC LIMIT 1;
-- and FIRST verify freshness coverage at that boundary. Coverage is SCOPED to the campaigns that
-- can actually affect an active budget flag (an ad-set flag's REAL parent, or a campaign-level flag's
-- own campaign) -- archived/historical campaigns cannot change any outcome and would only make broad
-- inventory coverage look poor:
--   WITH relevant AS (
--     SELECT a.campaign_id AS id FROM flags f
--       JOIN adsets a ON a.id = f.adset_id AND a.ad_account_id = :account
--       WHERE f.ad_account_id = :account AND f.is_active AND f.entity_level = 'adset'
--         AND f.flag_type IN ('loser','scale_candidate')
--     UNION
--     SELECT f.campaign_id FROM flags f
--       WHERE f.ad_account_id = :account AND f.is_active AND f.entity_level = 'campaign'
--         AND f.flag_type IN ('loser','scale_candidate'))
--   SELECT count(*) FILTER (WHERE c.last_synced_at >= :boundary::timestamptz) AS fresh, count(*) AS total
--   FROM campaigns c WHERE c.ad_account_id = :account AND c.id IN (SELECT id FROM relevant);
-- (The account-wide fresh-vs-total count is BROAD INVENTORY coverage only -- informative, not a gate.)
-- A row below means: metadata was FRESH at that boundary and proves the flag is on the wrong
-- optimization unit (structural), or the flag's target entity was deleted (orphaned). The result is
-- CONDITIONAL on that boundary's snapshot of Meta structure -- treat it as provisional until the
-- post-deploy manual sync (runbook step 7) re-derives the closures against CURRENT Meta metadata.

SELECT f.id, f.entity_level::text AS entity_level, f.flag_type::text AS flag_type,
       f.window_days, f.flag_date, 'structural_unit_change' AS would_close_reason
FROM public.flags f
WHERE f.ad_account_id = :account AND f.is_active
  AND f.flag_type IN ('loser','scale_candidate')
  AND (
    (f.entity_level = 'adset' AND EXISTS (
      SELECT 1 FROM public.adsets a
      JOIN public.campaigns c ON c.id = a.campaign_id AND c.ad_account_id = :account
      WHERE a.id = f.adset_id AND a.ad_account_id = :account
        AND c.last_synced_at >= :boundary::timestamptz
        AND (c.daily_budget IS NOT NULL OR c.lifetime_budget IS NOT NULL)))
    OR
    (f.entity_level = 'campaign' AND EXISTS (
      SELECT 1 FROM public.campaigns c
      WHERE c.id = f.campaign_id AND c.ad_account_id = :account
        AND c.last_synced_at >= :boundary::timestamptz
        AND c.daily_budget IS NULL AND c.lifetime_budget IS NULL))
  )

UNION ALL

SELECT f.id, f.entity_level::text, f.flag_type::text, f.window_days, f.flag_date,
       'orphaned_entity' AS would_close_reason
FROM public.flags f
WHERE f.ad_account_id = :account AND f.is_active
  AND ((f.entity_level = 'ad' AND f.ad_id IS NULL)
    OR (f.entity_level = 'adset' AND f.adset_id IS NULL)
    OR (f.entity_level = 'campaign' AND f.campaign_id IS NULL))
ORDER BY would_close_reason, entity_level, flag_date;
