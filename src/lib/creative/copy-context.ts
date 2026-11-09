import 'server-only'
import { accountCurrency, accountLocale } from '@/config/business-config'
import { promptBusiness, promptBusinessLine } from '@/config/prompt-business'
import { BUSINESS_PROFILE, type BusinessProfile } from '@/config/business-profile'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { promptBrandFacts } from '@/lib/knowledge/brand-facts'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { getRanCopyPerformance } from './copy-performance'
import { HOOK_CORPUS } from './hook-corpus'
import type { VerifiedFacts } from './copy-scorer'

// What the Copy studio grounds generation and scoring in: the business profile's VERIFIED facts (the
// same fact rule every prompt follows: an unconfigured example profile states nothing), the copy that
// actually ran in the account and earned enough delivery to rank, and the cited hook-pattern corpus.

export const PROVEN_COPY_WINDOW_DAYS = 30
export const PROVEN_COPY_LIMIT = 5

export interface ProvenCopy {
  hook: string
  headline: string | null
  link_ctr: number | null
  impressions: number
}

export interface CopyContext {
  businessLine: string
  businessName: string
  currency: string
  locale: string
  facts: VerifiedFacts
  personas: readonly string[]
  /** Social proof is an angle only when a verified fact carries it (reviews, ratings, client counts). */
  socialProofVerified: boolean
  provenCopy: ProvenCopy[]
  provenCopyStatus: 'ranked' | 'none_ranked' | 'unavailable' | 'no_account'
  provenCopyWindow: { start: string; end: string }
  hookPatterns: number
}

/** PURE over the profile: what copy may state and what it may never state. */
export function verifiedFacts(profile: BusinessProfile = BUSINESS_PROFILE): VerifiedFacts {
  const facts = promptBrandFacts(profile)
  return {
    statements: [facts.business_line, ...facts.differentiators, ...facts.pricing].filter(Boolean),
    unverified: facts.requires_verification,
  }
}

const SOCIAL_PROOF_FACT = /\b(?:reviews?|rated|rating|stars?|clients|customers|testimonials?|trusted)\b/i

export async function loadCopyContext(): Promise<CopyContext> {
  const facts = verifiedFacts()
  const business = promptBusiness()
  const provenCopyWindow = { start: nyDaysAgo(PROVEN_COPY_WINDOW_DAYS), end: nyDaysAgo(1) }
  let provenCopy: ProvenCopy[] = []
  let provenCopyStatus: CopyContext['provenCopyStatus'] = 'no_account'
  const account = await resolveOnlyActiveAccount()
  if (account.ok) {
    try {
      const groups = await getRanCopyPerformance(account.account.id, provenCopyWindow.start, provenCopyWindow.end)
      provenCopy = groups.filter((g) => g.verdict === 'ranked').slice(0, PROVEN_COPY_LIMIT)
        .map((g) => ({ hook: g.hook, headline: g.headline, link_ctr: g.link_ctr, impressions: g.impressions }))
      provenCopyStatus = provenCopy.length > 0 ? 'ranked' : 'none_ranked'
    } catch {
      provenCopyStatus = 'unavailable'
    }
  }
  return {
    businessLine: promptBusinessLine(business),
    businessName: business.name,
    currency: accountCurrency(),
    locale: accountLocale(),
    facts,
    personas: promptBrandFacts().personas,
    socialProofVerified: facts.statements.some((s) => SOCIAL_PROOF_FACT.test(s)),
    provenCopy,
    provenCopyStatus,
    provenCopyWindow,
    hookPatterns: HOOK_CORPUS.length,
  }
}
