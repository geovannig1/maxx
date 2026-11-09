import type pg from 'pg'

export interface PaidCohortLineageFixture {
  accountId: string
  campaignDbId: string
  adsetDbId: string
  activationId: string
  evaluationRunId: string
  recentGenerationId: string
  maturedGenerationId: string
  metaCampaignId: string
  metaAdsetId: string
}

/**
 * Remove only this fixture's immutable paid-measurement rows. Production code cannot do this; the
 * explicit replica role is confined to loopback integration teardown and mirrors the other 067
 * harnesses that must reset append-only test state between runs.
 */
export async function purgePaidCohortLineageFixture(
  db: pg.Client,
  fixture: PaidCohortLineageFixture,
): Promise<void> {
  await db.query('BEGIN')
  try {
    await db.query('SET LOCAL session_replication_role=replica')
    await db.query(`DELETE FROM public.paid_cohort_units WHERE ad_account_id=$1`, [fixture.accountId])
    await db.query(`DELETE FROM public.paid_cohort_generations WHERE ad_account_id=$1`, [fixture.accountId])
    await db.query(`DELETE FROM public.paid_measurement_activations WHERE ad_account_id=$1`, [fixture.accountId])
    await db.query(`DELETE FROM public.adsets WHERE id=$1`, [fixture.adsetDbId])
    await db.query(`DELETE FROM public.campaigns WHERE id=$1`, [fixture.campaignDbId])
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

export async function seedPaidCohortLineageFixture(
  db: pg.Client,
  fixture: PaidCohortLineageFixture,
): Promise<void> {
  await db.query(`INSERT INTO public.campaigns(id,ad_account_id,campaign_id)
    VALUES ($1,$2,$3)`, [fixture.campaignDbId, fixture.accountId, fixture.metaCampaignId])
  await db.query(`INSERT INTO public.adsets(id,ad_account_id,campaign_id,adset_id)
    VALUES ($1,$2,$3,$4)`, [fixture.adsetDbId, fixture.accountId, fixture.campaignDbId, fixture.metaAdsetId])
  await db.query(`INSERT INTO public.paid_measurement_activations(
    id,ad_account_id,activated_at,contract_version,policy_version,source_kind,source_ref)
    VALUES ($1,$2,'2026-06-01T12:00:00Z',1,1,'controlled_journey','integration lineage fixture')`,
  [fixture.activationId, fixture.accountId])
  // policy_version must be 3: the v3 cutover marker (`paid_cohort_policy_cutovers`) is present in a fully migrated
  // database, and enforce_current_paid_cohort_policy() then rejects new v2 generations outright.
  // Historical v1/v2 rows remain untouched audit history; only NEW publications are constrained.
  await db.query(`INSERT INTO public.paid_cohort_generations(
    id,ad_account_id,evaluation_run_id,cohort_kind,window_start,window_end,as_of_date,
    activation_id,contract_version,policy_version,source_heads,account_spend,entity_spend,
    landing_page_views,captured_landing_views,complete,blocker_codes,metrics,publication_fingerprint)
    VALUES
      ($1,$2,$3,'recent_scale','2026-07-16','2026-07-29','2026-07-30',$4,1,3,
       '{}',100,100,2,2,true,'{}','{}','11111111111111111111111111111111'),
      ($5,$2,$3,'matured_cut','2026-06-16','2026-07-15','2026-07-30',$4,1,3,
       '{}',300,300,3,3,true,'{}','{}','11111111111111111111111111111111')`,
  [fixture.recentGenerationId, fixture.accountId, fixture.evaluationRunId,
    fixture.activationId, fixture.maturedGenerationId])
  await db.query(`INSERT INTO public.paid_cohort_units(
    ad_account_id,generation_id,entity_level,entity_id,spend,landing_page_views,
    captured_touches,bookings,booked_value,complete,blocker_codes,metrics)
    VALUES
      ($1,$2,'adset',$4,100,2,2,4,880,true,'{}','{}'),
      ($1,$3,'adset',$4,300,3,3,0,0,true,'{}','{}')`,
  [fixture.accountId, fixture.recentGenerationId, fixture.maturedGenerationId, fixture.metaAdsetId])
}
