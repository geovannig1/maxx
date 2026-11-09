// N6 — cited hook-PATTERN corpus. A menu of established hook patterns the copy generator composes from,
// NOT a list of fabricated "500 hooks". Every entry cites a REAL, verifiable source (owner non-negotiable:
// no invented sources). Patterns are timeless structures; fill the [brackets] with VERIFIED studio facts.
// Nothing here claims a hook is "proven" for THIS account — proof only comes from ran_copy_performance.

export type EvidenceTier =
  | 'principle' // established psychology / classic direct-response (named published work)
  | 'practitioner' // documented by a named copywriter / agency / creative-analytics source

export interface HookPattern {
  key: string
  name: string
  /** What it does + when to reach for it. */
  structure: string
  /** Fill-in-the-blanks skeleton. Brackets = insert a VERIFIED studio fact. */
  skeleton: string
  /** A concrete, on-brand example (composed for Example Studio; NOT a claimed performer). */
  example: string
  source: string
  source_url?: string
  evidence_tier: EvidenceTier
}

export const HOOK_CORPUS: readonly HookPattern[] = [
  {
    key: 'curiosity_gap',
    name: 'Curiosity gap',
    structure: 'Open a small, specific information gap the reader needs to close; hint at the outcome without giving it away. An unanswered question is uncomfortable, so they read on.',
    skeleton: 'The [specific thing] most [audience] miss when they book a [category]',
    example: 'The one thing most local creators forget to check before a studio shoot',
    source: 'Copyhackers, "Learn How to Use the Curiosity Gap"',
    source_url: 'https://copyhackers.com/2014/04/curiosity-gap/',
    evidence_tier: 'practitioner',
  },
  {
    key: 'specificity',
    name: 'Specificity',
    structure: 'Swap a vague claim for a concrete number or detail. Specific reads as true; round and abstract reads as hype. A cornerstone of classic direct-response.',
    skeleton: '[Exact number/detail] [concrete noun], [second concrete detail]',
    example: '1,200 sq ft, north-facing windows, and a freight elevator for your gear',
    source: 'David Ogilvy, "Ogilvy on Advertising" (1983)',
    evidence_tier: 'principle',
  },
  {
    key: 'social_proof',
    name: 'Social-proof opener',
    structure: 'Lead with what similar people already do. Under uncertainty, people copy peers to decide what is correct.',
    skeleton: 'Why [kind of peers] shoot at [place] instead of [the common alternative]',
    example: 'Why local photographers book a private studio instead of renting an Airbnb',
    source: 'Robert Cialdini, "Influence: The Psychology of Persuasion" (1984), social proof',
    evidence_tier: 'principle',
  },
  {
    key: 'pattern_interrupt',
    name: 'Pattern interrupt',
    structure: 'Break the scroll with an unexpected, oddly specific opener that does not read like an ad. Buys the half-second the rest of the copy needs.',
    skeleton: '[Blunt, unexpected statement that contradicts the expected pitch]',
    example: 'Your last shoot did not look flat because of your camera.',
    source: 'Motion, "The 10 Top-Performing Facebook Ad Hooks"',
    source_url: 'https://motionapp.com/library/talk/the-10-top-performing-facebook-ad-hooks-to-use-in-2024/',
    evidence_tier: 'practitioner',
  },
  {
    key: 'imperative_open',
    name: 'Imperative / command open',
    structure: 'Start with a verb in the command form so the first word is already a call to action. Direct, active, built for the click.',
    skeleton: '[Command verb] [the desired outcome] [qualifier]',
    example: 'Book a private studio in town by the hour, not the day',
    source: 'Copyhackers, "Facebook ad copy: how to create the perfect ad"',
    source_url: 'https://copyhackers.com/2016/06/writing-facebook-ads/',
    evidence_tier: 'practitioner',
  },
  {
    key: 'loss_framing',
    name: 'Loss / negativity framing',
    structure: 'Name the cost of NOT acting. Losses loom larger than equivalent gains, so a well-placed downside can out-pull a benefit claim.',
    skeleton: 'Stop [losing/wasting] [resource] on [the inferior alternative]',
    example: 'Stop losing shoot days to bad light and cramped rentals',
    source: 'Kahneman & Tversky, "Prospect Theory" (Econometrica, 1979), loss aversion',
    evidence_tier: 'principle',
  },
  {
    key: 'question_open',
    name: 'Direct question',
    structure: 'Ask a specific yes-question the target answers "yes" to in their head, pulling them into the copy. Keep it tied to the audience and their problem.',
    skeleton: 'Shooting [content type] in [city]? [specific qualifier or pain]',
    example: 'Shooting content in town? You need more than a white wall.',
    source: 'WordStream, "Ways to Use the Curiosity Gap in Your Marketing"',
    source_url: 'https://www.wordstream.com/blog/ws/2017/04/10/curiosity-gap',
    evidence_tier: 'practitioner',
  },
]

/** Compact menu of the hook patterns for injection into a copy-generation prompt. */
export function hookPatternMenu(): string {
  return HOOK_CORPUS.map((h) => `- ${h.name}: ${h.structure} Skeleton: "${h.skeleton}"`).join('\n')
}
