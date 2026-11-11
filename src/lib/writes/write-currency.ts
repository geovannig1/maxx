import { accountCurrency } from '@/config/business-config'
import type { BudgetUnits } from '@/lib/platforms/types'
import { budgetParamValue } from './budget-param'
import type { GovernedWriteRequest } from './write-authority'

/** Budget limits, previews and Meta minor units are all denominated in the configured account currency
 *  (NEXT_PUBLIC_ACCOUNT_CURRENCY). A money-carrying write is refused unless the Meta ad account's own
 *  currency (ad_accounts.currency, synced from Meta) is that same currency and Meta lists its offset:
 *  otherwise a 100 "USD" ceiling could be sent as 100 JPY, or 100 JPY read as 10,000. */
export function currencyMismatch(accountCurrencyCode: unknown, units: Pick<BudgetUnits, 'supports'>): string | null {
  const configured = accountCurrency()
  if (typeof accountCurrencyCode !== 'string' || accountCurrencyCode !== configured) {
    return `The Meta ad account currency (${typeof accountCurrencyCode === 'string' ? accountCurrencyCode : 'unknown'}) does not match the configured account currency ${configured}. Budget writes are refused until they match.`
  }
  if (!units.supports(configured)) {
    return `Meta does not list ${configured} as an ad account currency. Budget writes are refused.`
  }
  return null
}

export function writeCarriesMoney(actionType: GovernedWriteRequest['actionType'], params: Record<string, unknown>): boolean {
  return actionType === 'adjust_budget' || (actionType === 'duplicate_adset' && budgetParamValue(params) != null)
}
