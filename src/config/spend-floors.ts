import { minSpendToJudge } from './business-config'

// Every currency-denominated spend floor, as a fixed multiple of ONE configured amount: the spend
// below which an entity is too early to judge, NEXT_PUBLIC_MIN_SPEND_TO_JUDGE in the account currency
// (default 20). The floors used to be fixed amounts sized for USD; at the default each equals the amount
// it replaced, so USD behaviour is unchanged. Getters read the setting on every access.
//
// Client-safe and dependency-free apart from business-config.

export const SPEND_FLOORS = {
  /** Too early to judge; also the dormancy, alert, copy-ranking and creative-health floors (1x). */
  get judge(): number { return minSpendToJudge() },
  /** Minimum spend before a cost-per-outcome, ROAS or MER band is judged (3x). */
  get costPerOutcomeGate(): number { return minSpendToJudge() * 3 },
  /** Modelled spend with zero modelled outcomes that makes a learned segment pattern 'weak' (4x). */
  get modelledZeroOutcome(): number { return minSpendToJudge() * 4 },
  /** Spend that counts as a sizeable sample for verdict confidence (10x). */
  get confidentSample(): number { return minSpendToJudge() * 10 },
  /** A daypart cell with spend above this and no outcome is shown as spend-without-outcome (1/10). */
  get heatmapSpendNoOutcome(): number { return minSpendToJudge() / 10 },
  /** The smallest CPA change per day the trajectory predictor treats as material (1/20 per day). */
  get materialCpaSlopePerDay(): number { return minSpendToJudge() / 20 },
  /** Seven-day spend with zero Meta and GA4 conversions that triggers the tracking check (2.5x). */
  get trackingCheck(): number { return minSpendToJudge() * 2.5 },
  /** Seven-day spend at which missing live conversion events become critical rather than a warning (2.5x). */
  get trackingCritical(): number { return minSpendToJudge() * 2.5 },
  /** Minimum spend in an audience or concept group before comparing it on cost (12.5x). */
  get audienceCompare(): number { return minSpendToJudge() * 12.5 },
  /** Live spend with no results before a group is called out (5x). */
  get audienceLiveNoResults(): number { return minSpendToJudge() * 5 },
  /** Post-change spend at or below which an entity counts as stopped (1/4). */
  get stoppedEntity(): number { return minSpendToJudge() / 4 },
  /** The smallest daily budget a proposed or executed budget change may set (1/20). */
  get minDailyBudget(): number { return minSpendToJudge() / 20 },
}
