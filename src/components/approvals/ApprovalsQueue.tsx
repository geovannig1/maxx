'use client'

import { useEffect, useState } from 'react'
import { Clock, FileArchive } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { StatePanel } from '@/components/ui/state-panel'

interface HistoricalRecordRef {
  id: string
  recorded_at: string | null
}

interface ApprovalHistoryResponse {
  status: 'CAMPAIGN_PLAN_REQUIRED'
  read_health: 'healthy' | 'unavailable'
  actionable: false
  error_code?: string
  historical_record_count: number | null
  historical_records: HistoricalRecordRef[]
}

const UNAVAILABLE_HISTORY: ApprovalHistoryResponse = {
  status: 'CAMPAIGN_PLAN_REQUIRED',
  read_health: 'unavailable',
  actionable: false,
  error_code: 'LEGACY_APPROVAL_HISTORY_UNAVAILABLE',
  historical_record_count: null,
  historical_records: [],
}

export function ApprovalsQueue() {
  const [history, setHistory] = useState<ApprovalHistoryResponse | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/approvals', { cache: 'no-store' })
        const body = await response.json() as Partial<ApprovalHistoryResponse>
        if (!active) return
        if (body.status !== 'CAMPAIGN_PLAN_REQUIRED' || !Array.isArray(body.historical_records)) {
          setHistory(UNAVAILABLE_HISTORY)
          return
        }
        setHistory({
          status: 'CAMPAIGN_PLAN_REQUIRED',
          read_health: body.read_health === 'healthy' ? 'healthy' : 'unavailable',
          actionable: false,
          error_code: body.error_code,
          historical_record_count: typeof body.historical_record_count === 'number'
            ? body.historical_record_count
            : null,
          historical_records: body.historical_records.flatMap((record) => (
            record && typeof record.id === 'string'
              ? [{ id: record.id, recorded_at: typeof record.recorded_at === 'string' ? record.recorded_at : null }]
              : []
          )),
        })
      } catch {
        if (active) setHistory(UNAVAILABLE_HISTORY)
      }
    })()
    return () => { active = false }
  }, [])

  return (
    <div className="card-base p-5 space-y-3">
      <div className="flex items-center gap-2">
        <FileArchive className="w-4 h-4" style={{ color: 'var(--warning)' }} />
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          Approval readiness
        </p>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        Blocker: CAMPAIGN_PLAN_REQUIRED.{' '}
        No actionable approval proposals are verified right now. Legacy creative/test approval rows are
        immutable audit history; proposal details are withheld until an account-scoped CampaignPlan can
        be verified server-side.
      </p>

      {history === null ? (
        <Skeleton className="h-12 rounded-lg" />
      ) : history.read_health === 'unavailable' ? (
        <StatePanel
          state="unavailable"
          title="Legacy approval history unavailable"
          description={`No actionable approval proposals are shown. Historical rows could not be read (${history.error_code ?? 'LEGACY_APPROVAL_HISTORY_UNAVAILABLE'}).`}
          compact
        />
      ) : (
        <div className="space-y-2">
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Legacy records retained for audit: {history.historical_record_count ?? history.historical_records.length}.
          </p>
          {history.historical_records.map((record) => (
            <div
              key={record.id}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
            >
              <code className="text-[11px] break-all" style={{ color: 'var(--text-secondary)' }}>{record.id}</code>
              <span className="inline-flex items-center gap-1 text-[11px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                <Clock className="w-3 h-3" /> {record.recorded_at ?? 'time unavailable'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
