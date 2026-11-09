export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { PageHeader } from '@/components/layout/PageHeader'
import { ApprovalsQueue } from '@/components/approvals/ApprovalsQueue'
import { ClipboardCheck } from 'lucide-react'
import Link from 'next/link'

export default async function ApprovalsPage() {
  await requireOwner()

  return (
    <div className="space-y-5 max-w-3xl">
      <PageHeader
        title="Approval readiness"
        icon={ClipboardCheck}
        subtitle="Readiness for true actionable proposals. Legacy creative/test rows stay demoted as immutable audit history."
      />

      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
          color: 'var(--warning)',
          background: 'var(--warning-bg)',
          border: '1px solid var(--warning-border)',
          borderLeft: '3px solid var(--warning)',
        }}
      >
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0, background: 'var(--warning)' }} />
        No true actionable approval proposal is currently verified. Legacy creative/test records cannot be accepted, rejected, or treated as setup guidance.
      </div>

      <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        Budget and status changes you propose and approve (pause, activate, daily budget, duplicate as paused) are on{' '}
        <Link href="/changes" className="underline" style={{ color: 'var(--accent)' }}>Changes</Link>.
      </p>

      <ApprovalsQueue />
    </div>
  )
}
