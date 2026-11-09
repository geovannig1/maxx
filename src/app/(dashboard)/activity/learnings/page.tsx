export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { Brain } from 'lucide-react'
import { activeAccountErrorCode, resolveOnlyActiveAccount, type ActiveAccountErrorCode } from '@/lib/accounts/active-account'
import { resolveDisplayAuthority } from '@/lib/authority/legacy-cutover'
import { getAdminClient } from '@/lib/supabase/admin'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { PageHeader } from '@/components/layout/PageHeader'
import { OutcomeReviewList, type OutcomeReviewItem } from '@/components/learnings/OutcomeReviewList'
import { EmptyState } from '@/components/ui/empty-state'
import { LowDataNotice } from '@/components/ui/LowDataNotice'
import { groupLearningNarrative, type NarrativeEntry } from '@/lib/recommendations/learning-narrative'
import type { LearningTone } from '@/lib/recommendations/learning-status'

interface LearningRead {
  outcomes: OutcomeReviewItem[]
  accountErrorCode: ActiveAccountErrorCode | null
  readFailed: boolean
}

async function readLearnings(): Promise<LearningRead> {
  const db = getAdminClient()
  const active = await resolveOnlyActiveAccount(db)
  if (!active.ok) return { outcomes: [], accountErrorCode: activeAccountErrorCode(active.reason), readFailed: false }

  const { data, error } = await db
    .from('recommendation_outcomes')
    .select('id, flag_type, audience_type, meta_entity_id, recommendation, outcome, outcome_note, review_status, estimate_only, metric_name, category, confidence, active_days, baseline_value, observed_value, recommended_on')
    .eq('ad_account_id', active.account.id)
    .not('outcome', 'is', null)
    .order('evaluated_at', { ascending: false })
    .limit(50)

  const outcomes = ((data ?? []) as OutcomeReviewItem[]).map((row) => ({
    ...row,
    recommendation: row.recommendation ? resolveDisplayAuthority(null, row.recommendation).copy : null,
  }))
  return { outcomes, accountErrorCode: null, readFailed: Boolean(error) }
}

const TONE_COLOR: Record<LearningTone, string> = {
  good: 'var(--success)', warn: 'var(--warning)', info: 'var(--accent)', neutral: 'var(--text-tertiary)',
}

function LearningSection({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-bold text-[var(--text-primary)]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

function EntryCard({ entry }: { entry: NarrativeEntry }) {
  return (
    <article className="card-base p-4" style={{ borderLeft: `3px solid ${TONE_COLOR[entry.tone]}` }}>
      <p className="text-sm font-semibold text-[var(--text-primary)]">{entry.title}</p>
      {entry.detail && <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{entry.detail}</p>}
      {entry.meta && <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">{entry.meta}</p>}
    </article>
  )
}

export default async function LearningsPage() {
  await requireOwner()

  const data = await readLearnings()
  const narrative = groupLearningNarrative({ outcomes: data.outcomes, patterns: [] })
  const outcomeWindow = `Latest ${data.outcomes.length} evaluated outcome${data.outcomes.length === 1 ? '' : 's'} across all dates.`

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader title="What Maxx Has Learned" icon={Brain} subtitle={narrative.headline} />

      {data.accountErrorCode ? (
        <ActiveAccountUnavailableNotice code={data.accountErrorCode} />
      ) : data.readFailed ? (
        <LowDataNotice title="Learning history unavailable" message="Reviewed outcomes could not be read. This is unavailable, not an empty learning history." tone="warning" />
      ) : data.outcomes.length === 0 ? (
        <div className="card-base">
          <EmptyState icon={Brain} title="No learnings yet" description="Maxx scores eligible recommendations after their outcome window, and only owner-reviewed causal outcomes become trusted historical context." tone="info" />
        </div>
      ) : (
        <>
          <LearningSection
            title={narrative.awaitingReview.length ? `Waiting on you · ${narrative.awaitingReview.length} to review` : 'Outcome review history'}
            subtitle={`${outcomeWindow} Review decisions govern learning eligibility only; they do not change live campaign delivery.`}
          >
            <OutcomeReviewList outcomes={data.outcomes} />
          </LearningSection>
          {narrative.trusted.length > 0 && (
            <LearningSection title="Owner-reviewed historical context" subtitle="Approved causal outcome records provide historical context; they do not authorize a current action.">
              <div className="space-y-2">{narrative.trusted.map((entry, index) => <EntryCard key={`trusted-${index}`} entry={entry} />)}</div>
            </LearningSection>
          )}
          {narrative.hypotheses.length > 0 && (
            <LearningSection title="Hypotheses — not yet trusted" subtitle="Signals Maxx is retaining without treating them as proven learning.">
              <div className="space-y-2">{narrative.hypotheses.map((entry, index) => <EntryCard key={`hypothesis-${index}`} entry={entry} />)}</div>
            </LearningSection>
          )}
          {narrative.excluded.length > 0 && (
            <LearningSection title="Excluded from learning" subtitle="These records remain visible with the reason they cannot become trusted learning.">
              <div className="space-y-2">{narrative.excluded.map(({ item, why }, index) => (
                <article key={`excluded-${index}`} className="card-base border-l-[3px] border-l-[var(--text-tertiary)] p-4">
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{item.title}</p>
                  {item.detail && <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{item.detail}</p>}
                  <p className="mt-1.5 text-xs text-[var(--text-tertiary)]">Why excluded: {why}</p>
                </article>
              ))}</div>
            </LearningSection>
          )}
        </>
      )}
    </div>
  )
}
