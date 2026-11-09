-- record_conversion_delivery: serialize concurrent writers for one outcome.
--
-- conversion_deliveries has two unique keys, event_id and (outcome_id, platform). The event id is
-- derived from the outcome, so both name the same row, but INSERT ... ON CONFLICT (event_id) only
-- arbitrates the first: two first deliveries for one outcome racing each other could hit
-- (outcome_id, platform) first and fail with 23505 instead of merging (seen in CI, capi-concurrency).
-- The read of the prior row (was_already_accepted) could also be stale under the same race.
--
-- A transaction-scoped advisory lock per outcome makes the writers take turns: each one then reads and
-- merges into the row the previous writer committed. Body otherwise unchanged from 0001_baseline.sql.

CREATE OR REPLACE FUNCTION public.record_conversion_delivery(p_outcome_id uuid, p_event_id text, p_event_time timestamp with time zone, p_value numeric, p_currency text, p_send_mode text, p_events_received integer, p_error_state text, p_error_class text, p_api_version text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_accepted boolean;
  v_live_accept boolean;
  v_test_accept boolean;
  v_now timestamptz := now();
  v_expected_event_id text;
  v_row public.conversion_deliveries%ROWTYPE;
  v_marked_sent boolean := false;
  v_parent_matches integer;
  v_was_live_accepted boolean;
  v_external_id text;
  v_source_kind text;
  v_origin text;
  v_sender_event_id text;
BEGIN
  IF p_outcome_id IS NULL THEN
    RAISE EXCEPTION 'record_conversion_delivery: outcome_id is required';
  END IF;
  -- One writer per outcome at a time (see the header): later writers see the committed row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'conversion-delivery:' || p_outcome_id::text, 0));
  IF p_event_id IS NULL OR btrim(p_event_id) = '' THEN
    RAISE EXCEPTION 'record_conversion_delivery: event_id is required';
  END IF;
  IF p_send_mode NOT IN ('live', 'test') THEN
    RAISE EXCEPTION 'record_conversion_delivery: send_mode must be live or test (got %)', p_send_mode;
  END IF;

  -- The event id is DERIVED from the outcome's source identity, never chosen by the caller. Acuity
  -- outcomes keep the historical `acuity-<Acuity id>` format so Meta still deduplicates them against
  -- the browser pixel copy. A missing outcome is a foreign-key violation, exactly as the old insert was.
  SELECT o.external_id, s.kind, o.origin, o.conversion_event_id INTO v_external_id, v_source_kind, v_origin, v_sender_event_id
    FROM public.outcomes o JOIN public.outcome_sources s ON s.id = o.source_id
   WHERE o.id = p_outcome_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_conversion_delivery: outcome % does not exist', p_outcome_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- A webhook source states its origin on every delivery: only a website outcome is ever sent.
  -- (Acuity proves origin from the by-id payload at send time, before its row may say so.)
  IF v_source_kind = 'webhook' AND v_origin IS DISTINCT FROM 'website' THEN
    RAISE EXCEPTION 'record_conversion_delivery: outcome % has origin %, only website outcomes are sent', p_outcome_id, v_origin
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A webhook sender may name the event id its own browser pixel uses, so the two deduplicate.
  v_expected_event_id := COALESCE(CASE WHEN v_source_kind = 'webhook' THEN v_sender_event_id END,
    public.conversion_event_id(v_source_kind, p_outcome_id, v_external_id));
  IF v_expected_event_id IS NULL THEN
    RAISE EXCEPTION 'record_conversion_delivery: no conversion event id format for source kind %', v_source_kind
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF btrim(p_event_id) <> v_expected_event_id THEN
    RAISE EXCEPTION 'record_conversion_delivery: event_id % does not match outcome % (expected %)',
      p_event_id, p_outcome_id, v_expected_event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO v_row FROM public.conversion_deliveries WHERE event_id = v_expected_event_id;
  IF FOUND AND v_row.outcome_id <> p_outcome_id THEN
    RAISE EXCEPTION 'record_conversion_delivery: event_id % already belongs to outcome %',
      v_expected_event_id, v_row.outcome_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  v_was_live_accepted := FOUND AND v_row.live_accepted_at IS NOT NULL;

  v_accepted := COALESCE(p_error_state IS NULL AND p_error_class IS NULL AND p_events_received = 1, false);
  v_live_accept := v_accepted AND p_send_mode = 'live';
  v_test_accept := v_accepted AND p_send_mode = 'test';

  INSERT INTO public.conversion_deliveries AS d (
    outcome_id, event_id, event_time, value_sent, currency_sent, send_mode,
    events_received, accepted_at, delivered_at, error_state, error_class,
    attempt_count, last_attempt_at, api_version,
    accepted_event_time, accepted_value, accepted_currency, accepted_send_mode,
    accepted_events_received, accepted_api_version, accepted_attempt_count, failed_attempt_count,
    live_accepted_at, test_accepted_at, test_accepted_count,
    last_attempt_event_time, last_attempt_value, last_attempt_currency, last_attempt_send_mode,
    last_attempt_events_received, last_attempt_error_state, last_attempt_error_class, last_attempt_api_version
  ) VALUES (
    p_outcome_id, v_expected_event_id, p_event_time, p_value, p_currency, p_send_mode,
    p_events_received,
    CASE WHEN v_live_accept THEN v_now END,
    CASE WHEN v_live_accept THEN v_now END,
    p_error_state, p_error_class,
    1, v_now, p_api_version,
    CASE WHEN v_live_accept THEN p_event_time END,
    CASE WHEN v_live_accept THEN p_value END,
    CASE WHEN v_live_accept THEN p_currency END,
    CASE WHEN v_live_accept THEN p_send_mode END,
    CASE WHEN v_live_accept THEN p_events_received END,
    CASE WHEN v_live_accept THEN p_api_version END,
    CASE WHEN v_live_accept THEN 1 ELSE 0 END,
    CASE WHEN v_accepted THEN 0 ELSE 1 END,
    CASE WHEN v_live_accept THEN v_now END,
    CASE WHEN v_test_accept THEN v_now END,
    CASE WHEN v_test_accept THEN 1 ELSE 0 END,
    p_event_time, p_value, p_currency, p_send_mode,
    p_events_received, p_error_state, p_error_class, p_api_version
  )
  ON CONFLICT (event_id) DO UPDATE SET
    -- LIVE accepted facts: written ONLY on the first LIVE acceptance, never restated. A prior TEST
    -- acceptance does not occupy this slot.
    live_accepted_at         = COALESCE(d.live_accepted_at, CASE WHEN v_live_accept THEN v_now END),
    accepted_at              = COALESCE(d.live_accepted_at, CASE WHEN v_live_accept THEN v_now END),
    delivered_at             = COALESCE(d.delivered_at, CASE WHEN v_live_accept THEN v_now END),
    accepted_event_time      = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.accepted_event_time      WHEN v_live_accept THEN p_event_time      ELSE d.accepted_event_time END,
    accepted_value           = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.accepted_value           WHEN v_live_accept THEN p_value           ELSE d.accepted_value END,
    accepted_currency        = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.accepted_currency        WHEN v_live_accept THEN p_currency        ELSE d.accepted_currency END,
    accepted_send_mode       = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.accepted_send_mode       WHEN v_live_accept THEN p_send_mode       ELSE d.accepted_send_mode END,
    accepted_events_received = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.accepted_events_received WHEN v_live_accept THEN p_events_received ELSE d.accepted_events_received END,
    accepted_api_version     = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.accepted_api_version     WHEN v_live_accept THEN p_api_version     ELSE d.accepted_api_version END,
    accepted_attempt_count   = d.accepted_attempt_count + CASE WHEN v_live_accept THEN 1 ELSE 0 END,
    -- TEST acceptances are recorded separately and never touch the live slot.
    test_accepted_at         = COALESCE(d.test_accepted_at, CASE WHEN v_test_accept THEN v_now END),
    test_accepted_count      = d.test_accepted_count + CASE WHEN v_test_accept THEN 1 ELSE 0 END,
    failed_attempt_count     = d.failed_attempt_count + CASE WHEN v_accepted THEN 0 ELSE 1 END,
    -- Legacy mirror columns freeze once LIVE-accepted.
    event_time      = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.event_time      ELSE p_event_time END,
    value_sent      = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.value_sent      ELSE p_value END,
    currency_sent   = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.currency_sent   ELSE p_currency END,
    send_mode       = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.send_mode       ELSE p_send_mode END,
    events_received = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.events_received ELSE p_events_received END,
    error_state     = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.error_state     ELSE p_error_state END,
    error_class     = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.error_class     ELSE p_error_class END,
    api_version     = CASE WHEN d.live_accepted_at IS NOT NULL THEN d.api_version     ELSE p_api_version END,
    last_attempt_event_time      = p_event_time,
    last_attempt_value           = p_value,
    last_attempt_currency        = p_currency,
    last_attempt_send_mode       = p_send_mode,
    last_attempt_events_received = p_events_received,
    last_attempt_error_state     = p_error_state,
    last_attempt_error_class     = p_error_class,
    last_attempt_api_version     = p_api_version,
    attempt_count   = d.attempt_count + 1,
    last_attempt_at = v_now
  RETURNING * INTO v_row;

  -- Only a LIVE acceptance stamps the parent.
  IF v_row.live_accepted_at IS NOT NULL THEN
    SELECT count(*) INTO v_parent_matches
    FROM public.outcomes WHERE id = v_row.outcome_id;
    IF v_parent_matches <> 1 THEN
      RAISE EXCEPTION 'record_conversion_delivery: expected exactly 1 outcome for id %, found %',
        v_row.outcome_id, v_parent_matches
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE public.outcomes
    SET conversion_sent_at = COALESCE(conversion_sent_at, v_row.live_accepted_at),
        conversion_send_error = NULL
    WHERE id = v_row.outcome_id;
    v_marked_sent := true;
  END IF;

  RETURN jsonb_build_object(
    'event_id', v_row.event_id,
    'outcome_id', v_row.outcome_id,
    'accepted', v_accepted,
    'live_accepted', v_live_accept,
    'test_accepted', v_test_accept,
    'ever_live_accepted', v_row.live_accepted_at IS NOT NULL,
    'was_already_accepted', v_was_live_accepted,
    'accepted_at', v_row.accepted_at,
    'live_accepted_at', v_row.live_accepted_at,
    'test_accepted_at', v_row.test_accepted_at,
    'delivered_at', v_row.delivered_at,
    'accepted_events_received', v_row.accepted_events_received,
    'attempt_count', v_row.attempt_count,
    'accepted_attempt_count', v_row.accepted_attempt_count,
    'test_accepted_count', v_row.test_accepted_count,
    'failed_attempt_count', v_row.failed_attempt_count,
    'last_attempt_error_state', v_row.last_attempt_error_state,
    'marked_sent', v_marked_sent
  );
END;
$$;
