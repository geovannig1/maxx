import type { LegacyVocabulary } from './legacy-vocabulary'

/**
 * Money keys Maxx once named after one currency, and their currency-neutral names. Amounts are in
 * the account currency. The shipped schema writes only the new keys; a stored document that still
 * carries an old one is upgraded when read with exactly this map (legacy-vocabulary.ts).
 */
export const LEGACY_MONEY_KEYS: Readonly<Record<string, string>> = {
  activeAmountPaidObservedUsd: 'activeAmountPaidObserved',
  activeAmountPaidRevenueUsd: 'activeAmountPaidRevenue',
  adSpendUsd: 'adSpendAmount',
  amountPaidRevenueUsd: 'amountPaidRevenue',
  amount_usd: 'amount',
  associatedAmountPaidRevenueUsd: 'associatedAmountPaidRevenue',
  associatedSpendUsd: 'associatedSpend',
  authoritativeSpendUsd: 'authoritativeSpend',
  bookedValueUsd: 'bookedValue',
  canceledAmountPaidObservedUsd: 'canceledAmountPaidObserved',
  clickImpliedValueUsd: 'clickImpliedValue',
  collectedRevenueExTaxUsd: 'collectedRevenueExTax',
  collectedUsd: 'collectedAmount',
  contributionAfterAdsUsd: 'contributionAfterAds',
  currentAccountDailyBudgetUsd: 'currentAccountDailyBudget',
  currentAccountTotalUsd: 'currentAccountTotal',
  dailyBudgetCeilingUsd: 'dailyBudgetCeiling',
  daily_budget_ceiling_usd: 'daily_budget_ceiling',
  daily_usd: 'daily_amount',
  governedContributionUsd: 'governedContribution',
  lifetime_usd: 'lifetime_amount',
  modeledBookingValueUsd: 'modeledBookingValue',
  paymentProcessingFeesUsd: 'paymentProcessingFees',
  pragmaticDailyBudgetCeilingUsd: 'pragmaticDailyBudgetCeiling',
  projectedAccountBudgetUsd: 'projectedAccountBudget',
  proposedAccountDailyBudgetUsd: 'proposedAccountDailyBudget',
  recommendedScaleBudgetUsd: 'recommendedScaleBudget',
  refundsAndChargebacksUsd: 'refundsAndChargebacks',
  spendExposureUsd: 'spendExposure',
  spendUsd: 'spendAmount',
  targetCurrentBudgetUsd: 'targetCurrentBudget',
  targetProposedBudgetUsd: 'targetProposedBudget',
  totalSpendUsd: 'totalSpend',
  valueUsd: 'valueAmount',
  variableFulfillmentCostsUsd: 'variableFulfillmentCosts',
  viewThroughValueUsd: 'viewThroughValue',
}

export const LEGACY_MONEY_VOCABULARY: LegacyVocabulary = { exact: LEGACY_MONEY_KEYS, prefixes: [] }
