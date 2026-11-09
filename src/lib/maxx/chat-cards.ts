// ADR-062 §5: the cards an Ask Maxx action returns. Client-safe types only. A card carries what the
// owner asked Maxx to produce (copy, a plan draft, a pending proposal), never a performance claim:
// numbers about the account stay in governed claims, and every card links to where it is reviewed.

export type ChatActionName = 'write_copy_variants' | 'draft_campaign_plan' | 'propose_decision_change'

export interface ChatCopyVariant {
  angle: string | null
  primary_text: string
  headline: string
  description: string
  cta: string
  score: number
  status: 'ready' | 'review'
  /** Scorer warnings to fix before running it (blocked variants never reach a card). */
  warnings: string[]
}

export type ChatCard =
  | { kind: 'copy'; variants: ChatCopyVariant[]; withheld: number; href: '/creative/copy' }
  | {
    kind: 'plan'; plan_id: string; version_id: string; href: string; source: 'ai' | 'template'
    name: string; objective: string; daily_budget: string; ad_sets: number; ads: number; new_creatives: number
    blockers: number; warnings: number; readiness: Array<{ label: string; status: string }>; notes: string[]
  }
  | { kind: 'approval'; change_request_id: string; href: '/changes'; preview: string; risk_level: string | null; status: string }
  | { kind: 'refusal'; action: ChatActionName | 'actions'; code: string; message: string }
