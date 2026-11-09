import type {
  AnswerBrief,
  AnswerBriefClaim,
  PersistedFinalActionDecisionEvidence,
} from '@/lib/maxx/answer-brief'
import type { MaxxToolEvidence } from '@/lib/maxx/chat-evidence'
import type { ChatCard } from '@/lib/maxx/chat-cards'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface MaxxChatResult {
  text: string
  toolsUsed: string[]
  evidence: MaxxToolEvidence[]
  availability: 'available' | 'partial' | 'unavailable'
  /**
   * Claims the governed tools supplied this turn, keyed by claimId.
   *
   * Exposed for evaluation only, for the same reason `brief` is: a gate that reads a cited claim's
   * properties must read the GOVERNED claim. The brief carries only claim IDS — the model selects,
   * the server renders — so this map is the sole source of every property a gate branches on.
   *
   * This used to describe `matchingPredicateError` checking a transcribed predicate field-by-field
   * against the server's re-derivation. That function is deleted: the comparison was server-vs-server
   * (the claim had already been fetched BY the id), so the transcription carried no information and
   * cost ~200-330 output tokens per citation against a 2048 budget.
   */
  claims: ReadonlyMap<string, AnswerBriefClaim>
  /**
   * The structured brief the model actually produced, or null when no governed answer was reached.
   *
   * `text` is not model output: every return path here is either a fixed string or the server-composed
   * render of this object, which has no prose-bearing field left open (`summary` is a literal,
   * `next_check` is null, and every other field is a claim ID). Anything grading `text` is therefore grading a
   * template — measured, a correct governed answer scores 0.00 on the keyword rubric while the string
   * "Maxx chat is disabled." scores 0.25. The model's judgement lives entirely in the SELECTION carried
   * here, so evaluation reads this and not the rendered string. Exposed for evaluation only; no product
   * surface renders it.
   */
  brief: AnswerBrief | null
  /**
   * Persisted final ActionDecisions the governed tools supplied this turn, keyed by id.
   *
   * Exposed for the same reason as `claims`: `scoreBrief`'s G6 reads `brief.action_decision_ids`,
   * which are model-supplied strings, and without this it could only COUNT them. Counting is what let
   * a brief citing fabricated decision ids score admissible.
   */
  actionDecisions: ReadonlyMap<string, PersistedFinalActionDecisionEvidence>
  /**
   * ADR-062: the card an owner action produced (copy variants, a plan draft, a pending proposal or a
   * refusal). Present only on an action turn; an answer to a question never carries one.
   */
  cards?: ChatCard[]
}
