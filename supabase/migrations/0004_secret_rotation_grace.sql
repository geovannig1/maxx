-- 0004: secret rotation grace period; network failures as transient signals-judge failures; report
-- business_revenue_complete stores collected-value coverage while money_basis.revenue_complete claims
-- completeness only for reconciled sources.
--
-- Forward-only; 0001_baseline.sql and 0002 are never edited.

-- 1. Signals judge: a transport failure with no HTTP status (connection reset, DNS, closed socket) is
--    transient like a timeout, a 429 or a provider 5xx (src/lib/signals/judge-attempts.ts). The retry
--    stays bounded by the per-item cap; only the recorded kind widens.
ALTER TABLE public.expert_insight_judge_attempts
  DROP CONSTRAINT expert_insight_judge_attempts_kind_check;
ALTER TABLE public.expert_insight_judge_attempts
  ADD CONSTRAINT expert_insight_judge_attempts_kind_check
  CHECK (last_failure_kind = ANY (ARRAY['timeout'::text, 'rate_limit'::text, 'server'::text, 'network'::text]));

-- 2. Webhook secret rotation grace period. Rotation used to replace the secret outright, so every
--    delivery the sender signed before switching was refused. A rotation may now keep the secret it
--    replaces verifying for a bounded window (0 to 86400 seconds, chosen per rotation; 0 stops it at
--    once, for a suspected leak). Only the most recently replaced secret is kept; it has the same shape
--    as a live secret, is server-side only like it, and is never returned while the window is over.
ALTER TABLE public.outcome_source_secrets
  ADD COLUMN previous_secret text,
  ADD COLUMN previous_secret_expires_at timestamp with time zone,
  ADD CONSTRAINT outcome_source_secrets_previous_secret_check
    CHECK (previous_secret IS NULL OR previous_secret ~ '^[0-9a-f]{64}$'::text),
  ADD CONSTRAINT outcome_source_secrets_previous_pair_check
    CHECK ((previous_secret IS NULL) = (previous_secret_expires_at IS NULL));

COMMENT ON TABLE public.outcome_source_secrets IS 'Signing secret of a webhook outcome source (32 random bytes, hex). Server-side only: service role only, never returned by an API after creation. Rotation replaces it; the replaced secret may keep verifying until previous_secret_expires_at (at most 24 hours).';

DROP FUNCTION public.rotate_outcome_webhook_secret(uuid, text);

-- Returns the replaced secret's window with the rotation itself, so a caller never needs a second
-- read (which could fail after the commit and lose the new secret). rotated = false: not a webhook source.
CREATE FUNCTION public.rotate_outcome_webhook_secret(p_source_id uuid, p_secret text, p_grace_seconds integer DEFAULT 0) RETURNS TABLE(rotated boolean, grace_until timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_until timestamp with time zone;
BEGIN
  IF p_grace_seconds IS NULL OR p_grace_seconds < 0 OR p_grace_seconds > 86400 THEN
    RAISE EXCEPTION 'webhook secret grace must be between 0 and 86400 seconds';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outcome_sources WHERE id = p_source_id AND kind = 'webhook') THEN
    RETURN QUERY SELECT false, NULL::timestamp with time zone;
    RETURN;
  END IF;
  INSERT INTO public.outcome_source_secrets AS k (source_id, secret) VALUES (p_source_id, p_secret)
  ON CONFLICT (source_id) DO UPDATE SET
    secret = EXCLUDED.secret,
    rotated_at = now(),
    previous_secret = CASE WHEN p_grace_seconds > 0 THEN k.secret END,
    previous_secret_expires_at = CASE WHEN p_grace_seconds > 0 THEN now() + make_interval(secs => p_grace_seconds) END
  RETURNING k.previous_secret_expires_at INTO v_until;
  RETURN QUERY SELECT true, v_until;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_outcome_webhook_secret(uuid, text, integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rotate_outcome_webhook_secret(uuid, text, integer) TO service_role;

-- The verifier reads the replaced secret only while its window is open (the return type changes, so
-- the function is dropped and created again).
DROP FUNCTION public.get_outcome_webhook_source(uuid);

CREATE FUNCTION public.get_outcome_webhook_source(p_source_id uuid) RETURNS TABLE(source_id uuid, ad_account_id uuid, secret text, timezone_name text, config jsonb, previous_secret text)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  SELECT s.id, s.ad_account_id, k.secret, a.timezone_name, s.config,
         CASE WHEN k.previous_secret_expires_at > now() THEN k.previous_secret END
    FROM public.outcome_sources s
    JOIN public.outcome_source_secrets k ON k.source_id = s.id
    JOIN public.ad_accounts a ON a.id = s.ad_account_id
   WHERE s.id = p_source_id AND s.kind = 'webhook' AND s.enabled;
$$;

REVOKE ALL ON FUNCTION public.get_outcome_webhook_source(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_outcome_webhook_source(uuid) TO service_role;

-- 3. Report money basis: money_basis.revenue_complete is now a completeness CLAIM, true only for reconciled
--    sources; a push-only source (signed webhook, CSV) cannot prove it. Collected-value coverage (every
--    active outcome has a recorded collected value) travels as money_basis.collected_value_coverage_complete,
--    and that is what business_revenue_complete stores, as its CHECK contract already requires. Reports
--    written before this change carry only revenue_complete, which was coverage then, so it is the fallback.
--    Body otherwise unchanged from 0001_baseline.sql.
CREATE OR REPLACE FUNCTION public.sync_report_money_basis_columns() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE v_basis jsonb := NEW.report_json->'money_basis';
BEGIN
  IF pg_catalog.jsonb_typeof(v_basis) = 'object' THEN
    NEW.money_basis_version := (v_basis->>'version')::integer;
    NEW.business_revenue_basis := v_basis->>'basis';
    NEW.outcome_source_available := (v_basis->>'source_available')::boolean;
    NEW.business_revenue_complete := COALESCE(
      (v_basis->>'collected_value_coverage_complete')::boolean, (v_basis->>'revenue_complete')::boolean);
    NEW.collected_value_lower_bound := (v_basis->>'observed_collected_value_lower_bound')::numeric;
    NEW.collected_value_covered_outcomes := (v_basis->>'covered_outcomes')::integer;
    NEW.collected_value_total_outcomes := (v_basis->>'total_outcomes')::integer;
  ELSIF TG_OP = 'UPDATE' AND OLD.money_basis_version = 0 THEN
    -- Historical rows remain immutable in meaning when unrelated rollup columns are restated.
    NEW.money_basis_version := OLD.money_basis_version;
    NEW.business_revenue_basis := OLD.business_revenue_basis;
    NEW.outcome_source_available := OLD.outcome_source_available;
    NEW.business_revenue_complete := OLD.business_revenue_complete;
    NEW.collected_value_lower_bound := OLD.collected_value_lower_bound;
    NEW.collected_value_covered_outcomes := OLD.collected_value_covered_outcomes;
    NEW.collected_value_total_outcomes := OLD.collected_value_total_outcomes;
  ELSE
    RAISE EXCEPTION 'new and current report rows require report_json.money_basis';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON COLUMN public.daily_reports.business_revenue_complete IS 'Collected-value coverage: every active outcome in the window has a recorded collected value. Not a source-completeness claim (report_json.money_basis.revenue_complete and source_completeness state that).';
COMMENT ON COLUMN public.weekly_reports.business_revenue_complete IS 'Collected-value coverage: every active outcome in the window has a recorded collected value. Not a source-completeness claim (report_json.money_basis.revenue_complete and source_completeness state that).';
