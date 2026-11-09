import 'server-only'
import { z } from 'zod'
import type { AiToolCall, AiToolDefinition } from '@/lib/ai'
import { generateCopy } from '@/lib/creative/copy-generator'
import { scoreCopy } from '@/lib/creative/copy-studio'
import { AUDIENCE_TEMPERATURES, COPY_GOALS } from '@/lib/creative/copy-rules'
import { draftCampaignPlan } from '@/lib/campaigns/plan-repository'
import { PLAN_GOALS } from '@/lib/campaigns/plan-brief'
import { proposeChangeFromDecision } from '@/lib/writes/owner-changes'
import { firstPlannableDate } from '@/lib/campaigns/plan-dates'
import { governMaxxAnswer } from './chat-governance'
import type { MaxxToolEvidence } from './chat-evidence'
import type { MaxxChatResult } from './chat-types'
import type { ChatActionName, ChatCard, ChatCopyVariant } from './chat-cards'

// ADR-062 §5: the three owner actions Ask Maxx can run. Each is a SINK: calling it ends the turn and
// the server answers with a card and a fixed, number-free sentence. The model supplies only the
// arguments the owner stated; the server validates them, runs the same services the console uses
// (generateCopy, draftCampaignPlan, proposeChangeFromDecision) and never approves, applies or submits
// anything. Copy is creative text, not a claim, and still passes the scorer: blocked variants never
// reach a card. A proposal is possible only from a governed decision shown in this conversation turn.

export const MAXX_CHAT_ACTIONS_CONTRACT = `MAXX OWNER ACTIONS (only when the owner explicitly asks for one):
- write_copy_variants: the owner asks you to write ad copy, hooks or headlines.
- draft_campaign_plan: the owner asks you to draft or plan a new campaign. Pass only values the owner stated (budget, countries, dates, product, offer). Never invent a missing value: leave it out and Maxx asks for it.
- propose_decision_change: the owner asks you to propose a change Maxx recommended. Use only an id from persisted_final_action_decisions returned this turn, and only an amount or name the owner stated.
- An action ends your turn. Call at most one action, and none unless asked. You cannot approve, apply, submit, activate or pause anything: the owner does that on the Changes page.
- Answering a question is still done only with submit_answer_brief.`

const text = (max: number) => z.string().trim().max(max)
const copyArgs = z.object({
  product: z.string().trim().min(2).max(200).optional(), offer: text(300).optional(), goal: z.enum(COPY_GOALS).optional(),
  audience_temperature: z.enum(AUDIENCE_TEMPERATURES).optional(), audience_description: text(300).optional(), count: z.number().int().min(1).max(6).optional(),
})
const planArgs = z.object({
  goal: z.enum(PLAN_GOALS).optional(), product: z.string().trim().min(2).max(200).optional(), offer: text(300).optional(),
  daily_budget: z.number().positive().max(1_000_000).optional(), countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).min(1).max(25).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  audience_description: text(300).optional(), destination_url: z.string().trim().url().max(2048).optional(),
})
const proposeArgs = z.object({
  action_decision_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  new_daily_budget: z.number().positive().optional(), new_name: z.string().trim().min(1).max(200).optional(),
})

const STR = { type: 'string' }
export const CHAT_ACTION_TOOL_DEFINITIONS: AiToolDefinition[] = [
  {
    name: 'write_copy_variants', description: 'Owner action: write scored Meta ad copy variants (hook, primary text, headline, CTA) for a product. Ends the turn with a copy card. Saves and publishes nothing.',
    input_schema: { type: 'object', properties: { product: STR, offer: STR, goal: { type: 'string', enum: [...COPY_GOALS] }, audience_temperature: { type: 'string', enum: [...AUDIENCE_TEMPERATURES] }, audience_description: STR, count: { type: 'integer', minimum: 1, maximum: 6 } }, required: ['product'] },
  },
  {
    name: 'draft_campaign_plan', description: 'Owner action: draft a complete campaign plan (structure, audiences, budget, copy) as a DRAFT for the owner to review. Ends the turn with a plan card. Submits and creates nothing.',
    input_schema: { type: 'object', properties: { goal: { type: 'string', enum: [...PLAN_GOALS] }, product: STR, offer: STR, daily_budget: { type: 'number' }, countries: { type: 'array', items: STR }, start_date: STR, end_date: STR, audience_description: STR, destination_url: STR }, required: ['goal', 'product'] },
  },
  {
    name: 'propose_decision_change', description: 'Owner action: propose the change a persisted Maxx decision supports, as a PENDING request the owner approves on the Changes page. Ends the turn with an approval card. Approves and applies nothing.',
    input_schema: { type: 'object', properties: { action_decision_id: STR, new_daily_budget: { type: 'number' }, new_name: STR }, required: ['action_decision_id'] },
  },
]
export const CHAT_ACTION_NAMES: ReadonlySet<string> = new Set(CHAT_ACTION_TOOL_DEFINITIONS.map((t) => t.name))

const LEADS = {
  copy: 'Here are copy variants for you to review, each scored against your verified business facts. Copy is creative text, not a performance claim, and nothing was saved or published. Save the ones you want in the Copy studio.',
  plan: 'I drafted a campaign plan. It is only a draft: nothing was submitted or created, and everything it would create starts paused. Review and edit it, then submit it for your approval.',
  approval: 'I proposed that change. It is waiting for your approval on the Changes page; it does not run until you approve it, and only with write mode on.',
  refusal: 'I could not complete that action. The card below says why.',
}

export interface ChatActionContext { ownerUserId: string; decisionIds: ReadonlySet<string>; toolsUsed: string[]; evidence: MaxxToolEvidence[] }

const refusal = (action: ChatActionName | 'actions', code: string, message: string): ChatCard => ({ kind: 'refusal', action, code, message })

async function copyAction(input: unknown): Promise<ChatCard> {
  const args = copyArgs.safeParse(input)
  if (!args.success || !args.data.product) return refusal('write_copy_variants', 'NEEDS_PRODUCT', 'Tell me which product or service the copy is for.')
  const result = await generateCopy({
    goal: args.data.goal ?? 'bookings', product: args.data.product, offer: args.data.offer ?? '',
    audience: { temperature: args.data.audience_temperature ?? 'cold', description: args.data.audience_description ?? '' },
    variants: args.data.count ?? 4, placements: ['feed'],
  })
  if (result.status !== 'ok') return refusal('write_copy_variants', result.code, result.message)
  // The generator already scored every variant; score again here so a card can never carry a blocker.
  const usable: ChatCopyVariant[] = result.variants.filter((v) => v.status !== 'blocked').flatMap((v) => {
    const score = scoreCopy({ hook: v.hook, primary_text: v.primary_text, headline: v.headline, description: v.description, cta: v.cta, angle: v.angle })
    if (!score.publishable) return []
    return [{
      angle: v.angle, primary_text: v.primary_text, headline: v.headline, description: v.description, cta: v.cta, score: score.score,
      status: score.score >= 70 ? 'ready' as const : 'review' as const, warnings: score.findings.filter((f) => f.severity === 'warning').map((f) => f.message).slice(0, 4),
    }]
  })
  if (usable.length === 0) return refusal('write_copy_variants', 'NO_USABLE_COPY', 'Every variant the model wrote failed the copy scorer (unverified claims or policy risk). Try a different brief in the Copy studio.')
  return { kind: 'copy', variants: usable, withheld: result.variants.length - usable.length, href: '/creative/copy' }
}

async function planAction(input: unknown, ownerUserId: string): Promise<ChatCard> {
  const args = planArgs.safeParse(input)
  if (!args.success) return refusal('draft_campaign_plan', 'INVALID_BRIEF', 'Some of the plan details were not usable. Tell me the goal, product, daily budget and countries again.')
  const a = args.data
  if (!a.goal || !a.product) return refusal('draft_campaign_plan', 'NEEDS_PRODUCT', 'Tell me the goal (sales, leads or traffic) and what the campaign promotes.')
  if (a.daily_budget === undefined) return refusal('draft_campaign_plan', 'NEEDS_DAILY_BUDGET', 'Tell me the daily budget you want for this campaign; Maxx never picks one for you.')
  if (!a.countries) return refusal('draft_campaign_plan', 'NEEDS_COUNTRIES', 'Tell me which countries to target.')
  const tomorrow = firstPlannableDate()
  const result = await draftCampaignPlan({
    goal: a.goal, product: a.product, offer: a.offer ?? '', daily_budget: a.daily_budget, audience_description: a.audience_description ?? '',
    countries: a.countries.map((c) => c.toUpperCase()), start_date: a.start_date ?? tomorrow, end_date: a.end_date ?? null,
    destination_url: a.destination_url ?? null, use_ai: true,
  }, { ownerUserId })
  const body = result.body as Record<string, unknown>
  if (result.http !== 201) return refusal('draft_campaign_plan', String(body.code ?? 'PLAN_DRAFT_FAILED'), String(body.error ?? 'The plan could not be drafted.'))
  const summary = body.summary as { name: string; objective: string; daily_budget: string; ad_sets: number; ads: number; new_creatives: number }
  const issues = (body.validation ?? []) as Array<{ severity: string }>
  const readiness = (body.readiness ?? []) as Array<{ label: string; status: string }>
  return {
    kind: 'plan', plan_id: String(body.plan_id), version_id: String(body.version_id), href: `/campaigns/plans/${String(body.plan_id)}`,
    source: body.source === 'ai' ? 'ai' : 'template', ...summary,
    blockers: issues.filter((i) => i.severity === 'blocker').length, warnings: issues.filter((i) => i.severity === 'warning').length,
    readiness: readiness.map((r) => ({ label: r.label, status: r.status })), notes: ((body.notes ?? []) as string[]).slice(0, 4),
  }
}

async function proposeAction(input: unknown, ctx: ChatActionContext): Promise<ChatCard> {
  const args = proposeArgs.safeParse(input)
  if (!args.success) return refusal('propose_decision_change', 'INVALID_PROPOSAL', 'That change could not be read. Ask again naming the recommendation.')
  if (!ctx.decisionIds.has(args.data.action_decision_id)) {
    return refusal('propose_decision_change', 'DECISION_NOT_SHOWN', 'I can only propose a change from a Maxx decision shown in this conversation. Ask me for today\'s recommendations first, or propose it on the Changes page.')
  }
  const params: Record<string, unknown> = {}
  if (args.data.new_daily_budget !== undefined) params.new_daily_budget = args.data.new_daily_budget
  if (args.data.new_name !== undefined) params.new_name = args.data.new_name
  // Never an override from the chat: a large step needs the owner's explicit confirmation on /changes.
  const result = await proposeChangeFromDecision(args.data.action_decision_id, ctx.ownerUserId, { actor: 'owner (Ask Maxx)', params })
  if ((result.http === 201 || result.http === 200) && result.change_request_id) {
    return { kind: 'approval', change_request_id: result.change_request_id, href: '/changes', preview: result.preview ?? '', risk_level: result.risk_level ?? null, status: result.status }
  }
  return refusal('propose_decision_change', result.status, result.message)
}

/** Run the one action the model called and answer with its card. Never approves or applies. */
export async function runChatActionTurn(calls: readonly AiToolCall[], ctx: ChatActionContext): Promise<MaxxChatResult> {
  const actions = calls.filter((call) => CHAT_ACTION_NAMES.has(call.name))
  let card: ChatCard
  if (actions.length !== 1) {
    card = refusal('actions', 'ONE_ACTION_PER_TURN', 'Ask for one thing at a time: copy, a campaign draft or one proposed change.')
  } else {
    const call = actions[0]
    const name = call.name as ChatActionName
    ctx.toolsUsed.push(name)
    card = name === 'write_copy_variants' ? await copyAction(call.input)
      : name === 'draft_campaign_plan' ? await planAction(call.input, ctx.ownerUserId)
        : await proposeAction(call.input, ctx)
  }
  const lead = card.kind === 'refusal' ? LEADS.refusal : LEADS[card.kind]
  return {
    text: governMaxxAnswer(lead, ctx.evidence, 'server_composed'),
    toolsUsed: [...new Set(ctx.toolsUsed)],
    evidence: ctx.evidence,
    availability: card.kind === 'refusal' ? 'partial' : 'available',
    brief: null,
    claims: new Map(),
    actionDecisions: new Map(),
    cards: [card],
  }
}
