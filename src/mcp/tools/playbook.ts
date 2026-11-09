import { getPlaybook, playbookMenu, renderPlaybook, PLAYBOOKS, type PlaybookIntent } from '@/lib/playbooks'
import { corpusEntry } from '@/lib/knowledge/corpus'

// MCP tool: historical evidence maps. The underlying playbooks predate the governed ActionDecision and
// CampaignPlan boundaries, so this tool never returns their procedures, rules, account benchmarks or
// action copy. Read-only evidence discovery only.

const INTENTS = PLAYBOOKS.map((p) => p.intent)

export function getPlaybookTool(args: { intent?: string }): object {
  const intent = args?.intent as PlaybookIntent | undefined

  if (!intent) {
    return {
      playbooks: playbookMenu(),
      authority: 'diagnostic_only',
      action_guidance_status: 'withheld',
      campaign_plan_status: 'unavailable',
      note:
        'Pass intent to get its historical evidence-tool map. These playbooks cannot originate actions. ' +
        'Use current governed recommendations for action guidance; setup and creative decisions require an approved stored CampaignPlan.',
    }
  }

  const p = getPlaybook(intent)
  if (!p) {
    return {
      error: 'UNKNOWN_INTENT',
      known_intents: INTENTS,
      note: `No playbook for "${intent}". Pick the closest from known_intents.`,
    }
  }

  // Preserve source-discovery utility without injecting the legacy account-fit claims or their action
  // implications. Current claims must come through the governed expert-knowledge path.
  const references = p.corpus_refs
    .map((key) => {
      const e = corpusEntry(key)
      return e ? {
        key,
        source_name: e.source.name,
        source_tier: e.source.tier,
        source_url: e.source.url ?? null,
        accessed: e.source.accessed,
        status: 'reference_only_claim_withheld',
      } : null
    })
    .filter((reference): reference is NonNullable<typeof reference> => reference !== null)

  return {
    intent: p.intent,
    authority: 'diagnostic_only',
    action_guidance_status: 'withheld',
    campaign_plan_status: 'unavailable',
    rendered: renderPlaybook(p),
    evidence_tools: [...new Set([
      ...p.required_evidence,
      ...p.procedure.flatMap((step) => step.tool ? [step.tool] : []),
    ])],
    references,
    note:
      'Historical playbook procedures and action rules are intentionally withheld. Gather evidence, then read governed current recommendations. ' +
      'Do not infer a budget, pause, scale, structure, event, landing-page, launch, or creative action from this response. ' +
      'Setup and creative-generation decisions also require a stored CampaignPlan the owner approves in the console.',
  }
}
