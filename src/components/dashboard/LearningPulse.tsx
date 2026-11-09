import Link from 'next/link'

// Tier 5 "Decisions & learning" — the small card that answers the owner's Q9/Q10/Q11: how many outcomes
// await his review, how many learnings he has approved, how many decisions are on record, and what Maxx
// is NOT yet safe to change. Presentational, server-rendered. Never fabricates — an unavailable count is
// omitted, not guessed (approvedLearnings === null hides that stat entirely).

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone?: string }) {
  return (
    <Link href={href} className="block min-w-[92px]" style={{ textDecoration: 'none' }}>
      <p style={{ fontSize: 20, fontWeight: 700, color: tone ?? 'var(--text-primary)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</p>
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
    </Link>
  )
}

export function LearningPulse({
  outcomesAwaitingReview,
  approvedLearnings,
  decisionsRecorded,
  notYetSafe,
  heldRecs,
}: {
  outcomesAwaitingReview: number
  approvedLearnings: number | null
  decisionsRecorded: number
  notYetSafe: string[]
  heldRecs: number
}) {
  return (
    <div className="card-base p-5">
      <p className="section-label mb-3">Decisions &amp; learning</p>
      <div className="flex gap-5 flex-wrap">
        <Stat label="Awaiting review" value={outcomesAwaitingReview} href="/activity/learnings" tone={outcomesAwaitingReview > 0 ? 'var(--warning)' : undefined} />
        {approvedLearnings !== null && (
          <Stat label="Approved learnings" value={approvedLearnings} href="/activity/learnings" tone={approvedLearnings > 0 ? 'var(--success)' : undefined} />
        )}
        <Stat label="Decisions recorded" value={decisionsRecorded} href="/launch" />
      </div>
      <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
        <p className="section-label mb-1.5">Not yet safe to change</p>
        {notYetSafe.length === 0 && heldRecs === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No blocks flagged — Maxx has enough signal for the changes it would propose.</p>
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {notYetSafe.length > 0 && <>Maxx is holding off on {notYetSafe.join(', ')} until there&apos;s enough data. </>}
            {heldRecs > 0 && <>{heldRecs} recommendation{heldRecs === 1 ? '' : 's'} held pending your decision.</>}
          </p>
        )}
      </div>
    </div>
  )
}
