import { describe, expect, it } from 'vitest'
import { MAXX_CHAT_SYSTEM, MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { MAXX_CHAT_ACTIONS_CONTRACT } from '@/lib/maxx/chat-actions'

// Two surfaces share one operating contract. The MCP stdio server exposes read and diagnostic tools only;
// Ask Maxx can also run the ADR-062 owner actions (write_copy_variants, draft_campaign_plan,
// propose_decision_change), which save drafts or open a pending change the owner approves on /changes.
// The chat prompt used to call itself a "read-only chat panel" pointing at a "Recommendations/Approvals
// feed", contradicting the actions contract appended right after it.

describe('model-facing write boundary per surface', () => {
  it('the MCP stdio server still says it exposes read and diagnostic tools only', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/this server exposes read and diagnostic tools only/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/nothing you call changes Meta/i)
    expect(MAXX_INSTRUCTIONS).not.toMatch(/write_copy_variants|draft_campaign_plan|propose_decision_change/)
  })

  it('the chat prompt no longer calls itself read-only or points at a feed that cannot act', () => {
    expect(MAXX_CHAT_SYSTEM).not.toMatch(/read-only chat/i)
    expect(MAXX_CHAT_SYSTEM).not.toMatch(/Recommendations\/Approvals/i)
    expect(MAXX_CHAT_SYSTEM).not.toMatch(/You have NO write tools/i)
    expect(MAXX_CHAT_SYSTEM).not.toMatch(/this server exposes read and diagnostic tools only/i)
  })

  it('the chat prompt states the owner-actions boundary the actions contract enforces', () => {
    expect(MAXX_CHAT_SYSTEM).toMatch(/nothing you call here changes Meta/i)
    expect(MAXX_CHAT_SYSTEM).toMatch(/MAXX OWNER ACTIONS/)
    expect(MAXX_CHAT_SYSTEM).toMatch(/only the owner approves/i)
    expect(MAXX_CHAT_SYSTEM).toMatch(/Changes page/)
    // The contract it refers to really names the same page and the same approver.
    expect(MAXX_CHAT_ACTIONS_CONTRACT).toMatch(/the owner does that on the Changes page/)
  })

  it('neither surface claims campaign plans or copy generation do not exist', () => {
    for (const prompt of [MAXX_INSTRUCTIONS, MAXX_CHAT_SYSTEM]) {
      expect(prompt).not.toMatch(/No stored CampaignPlan exists yet/i)
      expect(prompt).not.toMatch(/creative generation (?:are|is) unavailable/i)
    }
  })
})
