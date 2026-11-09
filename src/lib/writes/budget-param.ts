// The governed budget write parameter. The amount is in the account currency, so the parameter is
// `new_daily_budget`. `new_daily_budget_usd`, the name before the v1 release, is still accepted for one release: as an
// MCP tool argument, and as the key of action decisions and change requests stored under it (the
// change-request trigger accepts either key, exactly one at a time; migration 20261115000100).

export const BUDGET_PARAM = 'new_daily_budget'
/** @deprecated Accepted for one release; use BUDGET_PARAM. */
export const LEGACY_BUDGET_PARAM = 'new_daily_budget_usd'
export type BudgetParamKey = typeof BUDGET_PARAM | typeof LEGACY_BUDGET_PARAM

const has = (params: Record<string, unknown> | null | undefined, key: string) =>
  params != null && Object.prototype.hasOwnProperty.call(params, key)

/** PURE. The key a params object carries the budget under: the deprecated name only when it alone is present. */
export function budgetParamKey(params: Record<string, unknown> | null | undefined): BudgetParamKey {
  return has(params, LEGACY_BUDGET_PARAM) && !has(params, BUDGET_PARAM) ? LEGACY_BUDGET_PARAM : BUDGET_PARAM
}

/** PURE. The budget amount under either name (undefined when neither is present). */
export function budgetParamValue(params: Record<string, unknown> | null | undefined): unknown {
  if (!params) return undefined
  return has(params, BUDGET_PARAM) ? params[BUDGET_PARAM] : params[LEGACY_BUDGET_PARAM]
}

/** PURE. A copy carrying the budget (when present under either name) under `key` only. */
export function withBudgetKey(params: Record<string, unknown>, key: BudgetParamKey): Record<string, unknown> {
  if (!has(params, BUDGET_PARAM) && !has(params, LEGACY_BUDGET_PARAM)) return { ...params }
  const value = budgetParamValue(params)
  const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== BUDGET_PARAM && k !== LEGACY_BUDGET_PARAM))
  return { [key]: value, ...rest }
}

/** PURE. An MCP tool's budget argument under either name; both at once is refused as ambiguous. */
export function budgetFromToolArgs(input: object): { ok: true; value: unknown } | { ok: false; message: string } {
  const args = input as Record<string, unknown>
  if (has(args, BUDGET_PARAM) && has(args, LEGACY_BUDGET_PARAM)) {
    return { ok: false, message: `Refused: give ${BUDGET_PARAM} only (${LEGACY_BUDGET_PARAM} is its deprecated name).` }
  }
  return { ok: true, value: budgetParamValue(args) }
}
