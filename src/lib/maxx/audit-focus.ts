export type MaxxAuditFocus =
  | 'owner_ads_audit'
  | 'adset_setup'
  | 'creative_quality'
  | 'budget_goal'
  | 'general'

/** Deterministic routing for the compact governed evidence packet; it never selects an action. */
export function classifyMaxxAuditFocus(question: string): MaxxAuditFocus {
  const text = question.toLowerCase()
  if ((/\baudit\b|\btracking\b|\breconcil/.test(text))
      && (/\bcampaign\b|\bad sets?\b|\bscale|\bwarm\b|\bcold\b/.test(text))) {
    return 'owner_ads_audit'
  }
  if (/\bcreative|\bdivers|\bhook|\bformat|\bvideo|\bimage/.test(text)) return 'creative_quality'
  if (/\bbudget|\bconversion event|\boptimization (goal|event)|\boptimizing/.test(text)) return 'budget_goal'
  if (/\bad sets?\b|\bretarget|\bwarm\b|\baudience|\bsetup|\bset up/.test(text)) return 'adset_setup'
  return 'general'
}
