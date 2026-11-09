import {
  renderDailyDigestMarkdown,
  type DailyDigestV3,
} from '@/lib/report/daily-digest'

/**
 * Fixtures are built from the REAL exported v2 type and the REAL markdown renderer, never from a
 * hand-copied shape: a contract change must break this file loudly instead of leaving the email
 * tests asserting against a shape production no longer produces.
 *
 * Strings in the maximal and minimal fixtures are deliberately free of characters React escapes
 * (& < > " '), so tests can assert `html.toContain(<the same string>)` without re-implementing HTML
 * entity encoding. That is a convenience for those assertions, NOT a claim that escaping works —
 * `injectionDigestFixture` exists to prove that separately, with hostile input.
 */

export const MAXIMAL_ACCOUNT_NAME = 'Example Studio'

/** One string carrying all five characters React escapes, plus a complete script element. */
export const HOSTILE_STRING = 'Glam & Co <script>alert(1)</script> "V2" it\'s'

/** How many distinct fields `injectionDigestFixture` poisons; every one is rendered as text. */
export const HOSTILE_SITE_COUNT = 7

function withMarkdown(parts: Omit<DailyDigestV3, 'markdown'>): DailyDigestV3 {
  return { ...parts, markdown: renderDailyDigestMarkdown(parts) }
}

const LONG_AD_A =
  'Example Studio — Private Photography Studio Full Walkthrough Tour Video Variant B — Cold Prospecting 30s'
const LONG_AD_B =
  'Example Studio — Natural Light Makeup Station Setup Walkthrough D Variant D — Warm Retargeting 45s Vertical'
const LONG_AD_C =
  'Example Studio — Studio Reel A Hook Test Variant C Reserve Creative — Broad Advantage Plus Placement 15s Square'

/**
 * Every section populated, three long ad names, eight decisions: the rendered-size worst case the
 * 90KB Gmail-clipping budget is measured against.
 *
 * KPI coverage is deliberate — all three delta states plus a null value:
 *   spend         significant, rising
 *   leads         within_noise
 *   bookings_real value null (unavailable), no_baseline
 *   bookings_meta significant, falling
 *   ctr           within_noise
 *   cpl           no_baseline WITH a real value (a measurement never taken, not a flat one)
 */
const maximalParts: Omit<DailyDigestV3, 'markdown'> = {
  contract_version: 3,
  report_date: '2026-08-12',
  account_name: MAXIMAL_ACCOUNT_NAME,
  generated_from: 'committed_report_facts',
  action_authority_tier: 'diagnostic_only',
  prescriptions: [],
  change_reporting_threshold_pct: 20,
  subject: 'Maxx daily digest — 2026-08-12',
  states: {
    business: {
      state: 'mixed',
      line: 'Business: mixed — active bookings and amount paid on currently active appointments did not move together beyond the diagnostic reporting thresholds. Canceled, refunded, and settled amounts are not reconciled here.',
    },
    paid_delivery: {
      state: 'improving',
      line: 'Paid delivery: improving — cost per landing-page view improved beyond a diagnostic reporting threshold with no significant opposing signal.',
    },
    data_confidence: {
      state: 'degraded',
      line: 'Data confidence: degraded — at least one required source, cohort check, blocker, or material-change reason is incomplete.',
    },
  },
  pacing: { spend: 82.5, target: null, band: 'unavailable' },
  kpis: [
    { key: 'spend', label: 'Amount Spent', value: 82.5, unit: 'money', delta_pct: 34.2, noise_gated: false, state: 'significant' },
    { key: 'leads', label: 'Leads', value: 4, unit: 'count', delta_pct: 12.4, noise_gated: true, state: 'within_noise' },
    { key: 'bookings_real', label: 'Value-bearing bookings (Acuity ledger)', value: null, unit: 'count', delta_pct: null, noise_gated: true, state: 'no_baseline' },
    { key: 'bookings_meta', label: 'Meta-modelled bookings', value: 2, unit: 'count', delta_pct: -50, noise_gated: false, state: 'significant' },
    { key: 'ctr', label: 'CTR (all)', value: 1.83, unit: 'pct', delta_pct: -5.4, noise_gated: true, state: 'within_noise' },
    { key: 'cpl', label: 'Cost per lead', value: 20.63, unit: 'money', delta_pct: null, noise_gated: true, state: 'no_baseline' },
  ],
  flags: [
    'Zero conversions in 48 hours — the account recorded no AppointmentConfirmed event since 2026-08-10.',
    'Delivery is structurally starved of conversion signal for the current optimization event.',
    'The account is averaging roughly 11 optimization events per week against the 50 per week an ad set needs to exit learning.',
    'Example champion ad set 7-day: LEARNING_LIMITED · 42 results to exit.',
  ],
  creative: [
    `${LONG_AD_A}: fatigue watch. Retention: 18.4% reached Retention 25%. Frequency has climbed for six consecutive days against a flat trailing CTR baseline.`,
    `${LONG_AD_B}: healthy delivery. Retention: 24.1% reached Retention 25%.`,
    `${LONG_AD_C}: insufficient delivery to read. Retention: unavailable.`,
    'Exact paid creative outcomes are available in the committed diagnostic evidence; association is not causation.',
    `${LONG_AD_A}: frequency 3.10 in the 2.5-3.5 action band — review weekly.`,
    `${LONG_AD_B}: frequency 4.20 above the 2.5-3.5 action band — review weekly.`,
  ],
  decisions: [
    'Example champion ad set 7-day: the ad set has not exited learning and the budget change under review would reset it [approval required]',
    `${LONG_AD_A}: frequency is inside the weekly creative-review band and the retention proxy is below the account median [approval required]`,
    'Cold Prospecting CBO: campaign-level budget is carrying two ad sets with materially different result costs [approval required]',
    `${LONG_AD_C}: the reserve creative has never been served and cannot be compared to the champion [approval required]`,
    'Warm Retargeting 30-day: audience size is below the floor where delivery stays stable [approval required]',
    'Account: the summed active daily budget target moved without a recorded decision-ledger entry [approval required]',
    `${LONG_AD_B}: the ad has outspent the champion baseline result cost for three consecutive settled days [approval required]`,
    '3 quarantined recommendations omitted from the current feed.',
  ],
  narrative: {
    text: 'Business: mixed — active bookings and amount paid on currently active appointments did not move together beyond the diagnostic reporting thresholds. Canceled, refunded, and settled amounts are not reconciled here. Paid delivery: improving — cost per landing-page view improved beyond a diagnostic reporting threshold with no significant opposing signal. Data confidence: degraded — at least one required source, cohort check, blocker, or material-change reason is incomplete.',
    source: 'deterministic',
  },
  evidence_snapshot: {
    contract: 'executive_evidence_snapshot',
    version: 1,
    generated_at: '2026-08-13T10:00:00Z',
    as_of: '2026-08-12T23:59:59Z',
    last_complete_date: '2026-08-12',
  },
}

/**
 * The quiet-day floor: nothing broke, nothing is comparable, nothing was read by a model. Every KPI
 * is `no_baseline` with a null value, so this fixture is what proves an absent measurement never
 * renders as "within noise" and never renders as 0.
 */
const minimalParts: Omit<DailyDigestV3, 'markdown'> = {
  contract_version: 3,
  report_date: '2026-08-12',
  account_name: MAXIMAL_ACCOUNT_NAME,
  generated_from: 'committed_report_facts',
  action_authority_tier: 'diagnostic_only',
  prescriptions: [],
  change_reporting_threshold_pct: 20,
  subject: 'Maxx daily digest — 2026-08-12',
  states: {
    business: { state: 'unavailable', line: 'Business: unavailable — the executive evidence snapshot was not available.' },
    paid_delivery: { state: 'unavailable', line: 'Paid delivery: unavailable — the executive evidence snapshot was not available.' },
    data_confidence: { state: 'unavailable', line: 'Data confidence: unavailable — the executive evidence snapshot was not available.' },
  },
  pacing: { spend: null, target: null, band: 'unavailable' },
  kpis: [
    { key: 'spend', label: 'Amount Spent', value: null, unit: 'money', delta_pct: null, noise_gated: true, state: 'no_baseline' },
    { key: 'leads', label: 'Leads', value: null, unit: 'count', delta_pct: null, noise_gated: true, state: 'no_baseline' },
    { key: 'bookings_real', label: 'Value-bearing bookings (Acuity ledger)', value: null, unit: 'count', delta_pct: null, noise_gated: true, state: 'no_baseline' },
    { key: 'bookings_meta', label: 'Meta-modelled bookings', value: null, unit: 'count', delta_pct: null, noise_gated: true, state: 'no_baseline' },
    { key: 'ctr', label: 'CTR (all)', value: null, unit: 'pct', delta_pct: null, noise_gated: true, state: 'no_baseline' },
    { key: 'cpl', label: 'Cost per lead', value: null, unit: 'money', delta_pct: null, noise_gated: true, state: 'no_baseline' },
  ],
  flags: [],
  creative: [],
  decisions: [],
  narrative: {
    text: 'Business: unavailable — the executive evidence snapshot was not available. Paid delivery: unavailable — the executive evidence snapshot was not available. Data confidence: unavailable — the executive evidence snapshot was not available.',
    source: 'deterministic',
  },
  evidence_snapshot: maximalParts.evidence_snapshot,
}

/**
 * Hostile input at every text-interpolation site the template has. Ad names, account names and
 * recommendation reasons all originate in Meta and Acuity — data the app does not control — so the
 * escaping this relies on has to be pinned by a test rather than assumed from the framework.
 * `HOSTILE_SITE_COUNT` must equal the number of poisoned fields below.
 */
const injectionParts: Omit<DailyDigestV3, 'markdown'> = {
  ...maximalParts,
  account_name: HOSTILE_STRING,
  states: {
    ...maximalParts.states,
    business: { state: 'mixed', line: `Business: mixed — ${HOSTILE_STRING}` },
  },
  kpis: maximalParts.kpis.map((kpi, index) =>
    index === 0 ? { ...kpi, label: HOSTILE_STRING } : kpi,
  ),
  flags: [HOSTILE_STRING],
  creative: [HOSTILE_STRING],
  decisions: [HOSTILE_STRING],
  narrative: { text: HOSTILE_STRING, source: 'deterministic' },
}

export const maximalDigestFixture: DailyDigestV3 = withMarkdown(maximalParts)
export const minimalDigestFixture: DailyDigestV3 = withMarkdown(minimalParts)
export const injectionDigestFixture: DailyDigestV3 = withMarkdown(injectionParts)
