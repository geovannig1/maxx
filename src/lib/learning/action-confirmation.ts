// Action confirmation for outcome learning (item 4, rebuilt after review).
//
// A pause/refresh/scale flag may only mint a decisive worked/failed LESSON when the recommended action
// was actually recorded — and "recorded" must mean a real match, not merely "some row exists":
//   • account-scoped (loaders filter by ad_account_id),
//   • SUCCESSFUL (executed change requests; verified/applied action_log rows — never executing/failed),
//   • the RIGHT action for the flag (a budget change does not confirm a pause),
//   • on the RIGHT entity (meta id for writes/ledger; db entity_key or recommendation_id for decisions),
//   • INSIDE the flag's post-window (an action months later confirms nothing about this window).
// The owner-facing confirmation is recommendation_decisions.action_taken (the /recommendations
// "acted on" control) — with write mode off it is the ONLY source that ever fires.

export interface RecordedAction {
  /** write = Maxx-executed (change_requests / action_log); decision = owner's "acted on" on a
   *  recommendation; ledger = owner-recorded setup change (ad_setup_decisions). */
  kind: 'write' | 'decision' | 'ledger'
  /** write/ledger: the META entity id; decision: the rec's db entity_key ('account' when entity-less). */
  entityKey: string
  /** write: action_type (pause_ad | adjust_budget | …); decision: recommendation_type (pause | scale |
   *  …); ledger: setting_category (budget | …). */
  actionType: string
  /** YYYY-MM-DD the action actually happened (executed_at / action_taken_date — not request creation). */
  day: string
  /** decision only: the recommendation the owner acted on. */
  recommendationId?: string | null
}

export interface FlagActionContext {
  flagType: string
  /** YYYY-MM-DD the flag was raised. */
  flagDate: string
  metaEntityId: string | null
  /** The flag's db entity id (ad_id ?? adset_id ?? campaign_id) — recommendations key entity_key on it. */
  dbEntityKey: string | null
  /** The structured recommendation generated from this flag, when one exists. */
  recommendationId: string | null
}

/** Which Maxx write actions implement each flag's recommendation (tightened to the action that
 *  actually proves the intervention). A `duplicate_adset` is created PAUSED, so it adds no spend and
 *  replaces no creative — it proves neither scaling nor a refresh. A `pause_ad` proves a pause, not a
 *  refresh. `creative_refresh` has NO write action that proves it (a launched-new-creative confirmation
 *  is a future compound capability), so it stays empty and is never write-confirmed. */
export const FLAG_WRITE_ACTIONS: Record<string, readonly string[]> = {
  loser: ['pause_ad'],
  creative_refresh: [],
  scale_candidate: ['adjust_budget'],
}

/** Which recommendation types (recommendation_decisions.recommendation_type) implement each flag. */
export const FLAG_REC_TYPES: Record<string, readonly string[]> = {
  loser: ['pause'],
  creative_refresh: ['refresh_creative'],
  scale_candidate: ['scale'],
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** True when this recorded action confirms this flag: right window, right entity, right action. */
export function actionConfirmsFlag(a: RecordedAction, f: FlagActionContext, evalWindowDays: number): boolean {
  // Window: on the flag day (owner acts the same evening) through the end of the scored post-window.
  if (a.day < f.flagDate || a.day > addDays(f.flagDate, evalWindowDays)) return false

  if (a.kind === 'write') {
    return !!f.metaEntityId && a.entityKey === f.metaEntityId && (FLAG_WRITE_ACTIONS[f.flagType] ?? []).includes(a.actionType)
  }
  if (a.kind === 'decision') {
    // The acted-on decision must be the RIGHT type even when the recommendation ids match:
    // the grounding gate can downgrade a rec (e.g. scale -> hold), and an owner acting on that hold must
    // not confirm the flag's original action that was never taken. Type is necessary in BOTH branches.
    if (!(FLAG_REC_TYPES[f.flagType] ?? []).includes(a.actionType)) return false
    if (a.recommendationId && f.recommendationId && a.recommendationId === f.recommendationId) return true
    return !!f.dbEntityKey && a.entityKey === f.dbEntityKey
  }
  // ledger: only a recorded BUDGET setting change, and only for a scale flag — any other setup tweak
  // (attribution window, bid strategy, …) does not implement pause/refresh/scale recommendations.
  return f.flagType === 'scale_candidate' && !!f.metaEntityId && a.entityKey === f.metaEntityId && a.actionType === 'budget'
}

export function isActionConfirmed(actions: RecordedAction[], f: FlagActionContext, evalWindowDays: number): boolean {
  return actions.some((a) => actionConfirmsFlag(a, f, evalWindowDays))
}
