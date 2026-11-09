import { describe, it, expect } from 'vitest'
import { revalidateTask, revalidateTasks, taskDedupKey, type AccountReality } from '@/lib/report/task-revalidation'

// A realistic account state: delivering ~$70/day, 2 active campaigns, AppointmentConfirmed
// firing, paid bookings attributing. The 18 open "urgent" tasks were dormant-era fossils. Re-validation
// must close fossils whose premise is PROVABLY false while KEEPING everything it cannot disprove.
const LIVE: AccountReality = {
  spend7d: 371,
  hasActiveDelivery: true,
  appointmentEvents7d: 3,
  paidConfirmationEvents30d: 5,
  attributedShare: 1,
}
const DORMANT: AccountReality = {
  spend7d: 0,
  hasActiveDelivery: false,
  appointmentEvents7d: 0,
  paidConfirmationEvents30d: 0,
  attributedShare: null,
}

const t = (title: string, description = '', recommendation = '') => ({ id: title.slice(0, 8), title, description, recommendation })

describe('revalidateTask — positive-invalidation-only', () => {
  it('closes the "$0 spend / paused account" fossil when spend > 0', () => {
    expect(revalidateTask(t('**HIGH: Diagnose why the account is spending $0.00 — check billing'), LIVE)).toMatch(/delivering/)
  })
  it('closes the "launch the campaign / no active presence" fossil when campaigns are active', () => {
    expect(revalidateTask(t('**HIGH: Build and launch the Consumer Audience cold campaign — zero consumer-audience paid presence today'), LIVE)).toMatch(/active delivering campaigns/i)
  })
  it('closes the "pixel not firing / 0 events" fossil when AppointmentConfirmed fires', () => {
    expect(revalidateTask(t('**HIGH: Verify the AppointmentConfirmed pixel event is firing correctly'), LIVE)).toMatch(/firing/)
  })
  it('closes the "attribution broken / 0 paid bookings" fossil when paid attribution works', () => {
    expect(revalidateTask(t('**HIGH: GA4 shows 0 paid bookings; attribution is broken'), LIVE)).toMatch(/attribution is working/i)
  })

  it('KEEPS the genuine conversion-value task — no reality signal disproves it', () => {
    expect(revalidateTask(t('**HIGH: Set the AppointmentConfirmed conversion value in Meta Events Manager (set to $265)'), LIVE)).toBeNull()
  })
  it('KEEPS a generic creative-testing task', () => {
    expect(revalidateTask(t('**MEDIUM: Test a static image variant of the top hook'), LIVE)).toBeNull()
  })

  it('does NOT close fossils when reality still matches the premise (dormant account stays dormant)', () => {
    expect(revalidateTask(t('**HIGH: Diagnose why the account is spending $0.00'), DORMANT)).toBeNull()
    expect(revalidateTask(t('**HIGH: Build and launch the cold campaign'), DORMANT)).toBeNull()
  })

  it('revalidateTasks returns only the invalidated ids', () => {
    const tasks = [
      t('**HIGH: Diagnose why the account is spending $0.00'),
      t('**HIGH: Set the AppointmentConfirmed conversion value in Meta Events Manager'),
    ]
    const closed = revalidateTasks(tasks, LIVE)
    expect(closed).toHaveLength(1)
    expect(closed[0].id).toBe(tasks[0].id)
  })
})

describe('taskDedupKey', () => {
  it('collapses the priority prefix + markdown so re-authored duplicates match', () => {
    expect(taskDedupKey('**HIGH: Set the AppointmentConfirmed conversion value in Meta Events Manager (set to $265)')).toBe(
      taskDedupKey('**MEDIUM: Set the AppointmentConfirmed conversion value in Meta Events Manager (set to $250)'),
    )
  })
  it('distinguishes genuinely different instructions', () => {
    expect(taskDedupKey('**HIGH: Launch the cold campaign')).not.toBe(taskDedupKey('**HIGH: Set the conversion value'))
  })
})

describe('findDuplicateTaskIds', () => {
  it('collapses verbatim re-authored dups (the finding: "same task once per daily report"), keeps the original', async () => {
    const { findDuplicateTaskIds } = await import('@/lib/report/task-revalidation')
    const dups = findDuplicateTaskIds([
      { id: 'a', title: '**HIGH: Set the AppointmentConfirmed conversion value in Meta Events Manager ($265)' },
      { id: 'b', title: '**MEDIUM: Set the AppointmentConfirmed conversion value in Meta Events Manager ($250)' }, // same instruction, re-authored
      { id: 'd', title: '**HIGH: Launch the cold campaign' },
    ])
    expect(dups).toEqual(['b']) // 'a' kept (original), 'b' dismissed; 'd' distinct
  })
  it('does NOT merge paraphrases of the same topic (conservative — avoids collapsing genuinely distinct tasks)', async () => {
    const { findDuplicateTaskIds } = await import('@/lib/report/task-revalidation')
    // Real-world: the LLM paraphrased "set a conversion value" 4 different ways across 4 days. Prefix
    // dedup deliberately leaves these — fuzzy semantic merging risks combining distinct instructions.
    const dups = findDuplicateTaskIds([
      { id: 'a', title: '**HIGH: Set the AppointmentConfirmed conversion value in Meta Events Manager' },
      { id: 'b', title: '**HIGH: Add a static conversion value to the AppointmentConfirmed event in Meta' },
      { id: 'c', title: '**HIGH: Set a conversion value on AppointmentConfirmed in Meta Events Manager' },
    ])
    expect(dups).toEqual([])
  })
})

// ── Hardening — the six wrongly-closed attacks must all KEEP ──
describe('revalidateTask — adversarial task titles are KEPT', () => {
  it('A1: forward scaling task mentioning "toggled on"', () => {
    expect(revalidateTask(t('Now that the Retargeting ad set is toggled on, scale its budget 20% once CPA holds under $64.'), LIVE)).toBeNull()
  })
  it('A2: entity-scoped "$0.00" while the account delivers', () => {
    expect(revalidateTask(t('The Lookalike 1% ad set has spent $0.00 in 3 days despite ACTIVE status — investigate why it is not getting delivery.'), LIVE)).toBeNull()
  })
  it('A3: launch a NEW campaign as an expansion', () => {
    expect(revalidateTask(t('Launch a new cold-audience prospecting campaign to complement the retargeting that is working.'), LIVE)).toBeNull()
  })
  it('A4: negated hold directive ("Do NOT launch until…")', () => {
    expect(revalidateTask(t('Do NOT launch the cold-audience campaign until the pixel clears 50 events/week.'), LIVE)).toBeNull()
  })
  it('A5: pixel verification for OTHER events (AddToCart/ViewContent)', () => {
    expect(revalidateTask(t('Audit the pixel to verify AddToCart and ViewContent are firing before we optimize for them.'), LIVE)).toBeNull()
  })
  it('A6: campaign-specific "no paid bookings" while account has some', () => {
    expect(revalidateTask(t('The Campaign C ad set has driven no paid bookings in two weeks despite $400 spend — pause or rebuild it.'), LIVE)).toBeNull()
  })
  it('E1: reactivation fossil now closes (dormancy premise disproven)', () => {
    expect(revalidateTask(t('The account has been paused for three months — reactivate the Summer Promo campaign.'), LIVE)).toMatch(/active delivering/i)
  })
  it('still closes the original genuine fossils', () => {
    expect(revalidateTask(t('**HIGH: Diagnose why the account is spending $0.00 — check billing'), LIVE)).toMatch(/delivering/)
    expect(revalidateTask(t('**HIGH: Verify the AppointmentConfirmed pixel event is firing correctly'), LIVE)).toMatch(/firing/)
    expect(revalidateTask(t('**HIGH: GA4 shows 0 paid bookings; attribution is broken'), LIVE)).toMatch(/attribution is working/i)
  })
})

describe('taskDedupKey — full-string, digit-stripped', () => {
  it('does NOT collide two different instructions sharing a long prefix', async () => {
    const a = taskDedupKey('Review the AppointmentConfirmed conversion value in Events Manager and set it to the average booking price.')
    const b = taskDedupKey('Review the AppointmentConfirmed conversion value in Events Manager and switch to dynamic per-service pricing.')
    expect(a).not.toBe(b)
  })
  it('still collapses number-tweaked re-authoring of the same instruction', () => {
    expect(taskDedupKey('**HIGH: Set the AppointmentConfirmed conversion value in Meta Events Manager (set to $265)')).toBe(
      taskDedupKey('**MEDIUM: Set the AppointmentConfirmed conversion value in Meta Events Manager (set to $250)'),
    )
  })
  it('strips CRITICAL:/P1: style prefixes too', () => {
    expect(taskDedupKey('CRITICAL: Fix the pixel')).toBe(taskDedupKey('P1: Fix the pixel'))
  })
})
