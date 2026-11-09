'use client'

import { useState } from 'react'
import { AlertTriangle, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { accountTimezone } from '@/config/business-config'

// ADR-059: one change request as the owner reviews it. Everything being approved is on the card;
// the buttons are exactly what the server will do (cardControls). With write mode ON the first click
// only arms a confirmation, because applying spends real money.

export type WriteModeState = 'on' | 'off' | 'demo'
export type CardControl = 'approve' | 'approve_and_apply' | 'execute' | 'reject' | 'rollback' | 'recover'

export interface ChangeCard {
  id: string
  /** Null only on historical rows created before ActionDecision lineage became mandatory. */
  action_decision_id: string | null
  status: string
  action_type: string
  entity_level: string
  meta_entity_id: string
  params: Record<string, unknown> | null
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
  preview: string | null
  reason: string | null
  confidence: number | null
  risk_level: string | null
  rollback_plan: string | null
  requested_by: string | null
  created_at: string
  expires_at: string | null
  executed_at: string | null
  evidence: string | null
  data_source: string | null
  initiated_by: string | null
  rollback_of: string | null
  step_override: boolean | null
  result: Record<string, unknown> | null
  /** ADR-062: a campaign plan's creation (or its archive rollback); its lineage instead of a decision. */
  campaign_plan_version_id?: string | null
  /** Security review M1: a run of this change started then and never finished; it holds the account lock. */
  stuck_since?: string | null
}

const ACTION_LABEL: Record<string, string> = {
  pause_ad: 'Pause ad', activate_ad: 'Activate ad', adjust_budget: 'Set daily budget', duplicate_adset: 'Duplicate ad set',
  create_campaign_paused: 'Create campaign (paused)', archive_campaign_plan_objects: 'Archive a created campaign',
}
const RISK_COLOR: Record<string, string> = { low: 'var(--success)', medium: 'var(--warning)', high: 'var(--danger)' }
const ROLLBACKABLE = new Set(['pause_ad', 'activate_ad', 'adjust_budget', 'create_campaign_paused'])
const isPlan = (change: Pick<ChangeCard, 'campaign_plan_version_id'>) => change.campaign_plan_version_id != null
/** A decision or (ADR-062) a campaign plan version authorises the row; neither means a historical row. */
const hasLineage = (change: Pick<ChangeCard, 'action_decision_id' | 'campaign_plan_version_id'>) => change.action_decision_id != null || isPlan(change)

const isExpired = (change: Pick<ChangeCard, 'expires_at'>, now = Date.now()) =>
  change.expires_at !== null && Date.parse(change.expires_at) <= now

/** PURE: the controls the server will honour for this row in this write mode. */
export function cardControls(change: ChangeCard, writeMode: WriteModeState, now = Date.now()): CardControl[] {
  // A stuck run blocks every write on the account: recovering it is the one useful action.
  if (change.stuck_since) return ['recover']
  const applies = writeMode !== 'off'
  if (change.status === 'executed') {
    return ROLLBACKABLE.has(change.action_type) && !change.rollback_of && hasLineage(change) ? ['rollback'] : []
  }
  // ADR-062: a creation that failed part-way can be resumed (only the missing objects) or rolled back.
  if (change.status === 'failed' && isPlan(change) && change.action_type === 'create_campaign_paused') {
    return [...(applies && !isExpired(change, now) ? ['execute' as const] : []), 'rollback']
  }
  if (change.status === 'approved') return applies && !isExpired(change, now) && hasLineage(change) ? ['execute'] : []
  if (change.status !== 'pending') return []
  if (!hasLineage(change) || isExpired(change, now)) return ['reject']
  return [applies ? 'approve_and_apply' : 'approve', 'reject']
}

const CONTROL_LABEL: Record<CardControl, string> = {
  approve: 'Approve', approve_and_apply: 'Approve & apply', execute: 'Apply now', reject: 'Reject', rollback: 'Roll back', recover: 'Recover stuck change',
}

function dateTime(iso: string | null): string {
  if (!iso) return 'unknown'
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: accountTimezone() })
  } catch { return iso }
}

/** PURE: a plan preview as header lines, each with the detail lines indented under it (6+ spaces). */
export function previewBlocks(preview: string): Array<{ line: string; details: string[] }> {
  return preview.split('\n').reduce<Array<{ line: string; details: string[] }>>((blocks, line) => {
    const last = blocks[blocks.length - 1]
    if (last && /^ {6}/.test(line)) return [...blocks.slice(0, -1), { ...last, details: [...last.details, line.trim()] }]
    return [...blocks, { line, details: [] }]
  }, [])
}

function stateLine(state: Record<string, unknown> | null): string {
  if (!state) return 'not recorded'
  const keys = ['status', 'daily_budget', 'name'].filter((key) => state[key] !== undefined && state[key] !== null)
  return keys.length ? keys.map((key) => `${key.replace(/_/g, ' ')}: ${String(state[key])}`).join(' · ') : 'recorded'
}

export function ChangeApprovalCard({
  change, writeMode, onResult,
}: {
  change: ChangeCard
  writeMode: WriteModeState
  onResult: (change: ChangeCard, control: CardControl, response: { ok: boolean; body: Record<string, unknown> }) => void
}) {
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState<CardControl | null>(null)
  const controls = cardControls(change, writeMode)
  const risk = (change.risk_level ?? 'medium').toLowerCase()
  const riskColor = RISK_COLOR[risk] ?? 'var(--warning)'
  const expired = isExpired(change)
  const simulated = change.result?.simulated === true
  const owner = change.initiated_by === 'owner'
  const plan = isPlan(change)
  const createdObjects = Array.isArray(change.result?.objects) ? (change.result?.objects as Array<{ kind?: string; meta_id?: string | null }>) : []

  async function run(control: CardControl) {
    const live = writeMode === 'on' && (control === 'approve_and_apply' || control === 'execute')
    if (live && armed !== control) { setArmed(control); return }
    setBusy(true)
    try {
      const response = control === 'rollback'
        ? await fetch(`/api/changes/${change.id}/rollback`, { method: 'POST' })
        : await fetch(`/api/changes/${change.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: control }),
        })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      onResult(change, control, { ok: response.ok, body })
    } catch {
      onResult(change, control, { ok: false, body: { status: 'NETWORK_ERROR' } })
    } finally {
      setBusy(false)
      setArmed(null)
    }
  }

  return (
    <article data-change-id={change.id} className="card-base p-4 space-y-3" aria-label={`${ACTION_LABEL[change.action_type] ?? change.action_type} ${change.meta_entity_id}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {ACTION_LABEL[change.action_type] ?? change.action_type}
            <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}> · {change.entity_level} {change.meta_entity_id}</span>
          </p>
          <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {owner ? 'You proposed this' : `Proposed by ${change.requested_by ?? 'Maxx'}`}
            {change.rollback_of ? ' · rollback of an applied change' : ''} · status {change.status}
          </p>
        </div>
        <span className="text-[11px] font-bold uppercase rounded-md px-2 py-0.5" style={{ color: riskColor, border: `1px solid ${riskColor}` }}>
          {risk} risk
        </span>
      </div>

      {change.preview && !plan && (
        <p className="rounded-lg p-3 text-[13px] leading-relaxed whitespace-pre-line" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {change.preview}
        </p>
      )}
      {change.preview && plan && (
        <div data-plan-preview className="rounded-lg p-3 text-[13px] leading-relaxed whitespace-pre-line space-y-1" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          {previewBlocks(change.preview).map((block, i) => (block.details.length === 0
            ? <p key={i}>{block.line}</p>
            : (
              <details key={i} className="pl-4">
                <summary className="cursor-pointer">{block.line.trim()}</summary>
                <div className="pl-4 pt-1 text-[12px] break-words" style={{ color: 'var(--text-secondary)' }}>
                  {block.details.map((d, j) => <p key={j}>{d}</p>)}
                </div>
              </details>
            )))}
        </div>
      )}
      {change.stuck_since && (
        <p data-stuck-since={change.stuck_since} className="text-[12px] flex items-center gap-1" style={{ color: 'var(--danger)' }}>
          <AlertTriangle size={12} /> A run of this change started {dateTime(change.stuck_since)} and never finished; it blocks every change on this account.
          Recovering records its outcome as unknown (with what Meta shows now) and frees the account. Nothing is re-applied.
        </p>
      )}
      {change.step_override && (
        <p className="text-[12px] flex items-center gap-1" style={{ color: 'var(--danger)' }}>
          <AlertTriangle size={12} /> You confirmed a budget step above the per-change limit.
        </p>
      )}

      <dl className="grid gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {change.evidence && <div><dt className="inline font-semibold">Evidence: </dt><dd className="inline">{change.evidence}</dd></div>}
        {change.rollback_plan && <div><dt className="inline font-semibold">Rollback: </dt><dd className="inline">{change.rollback_plan}</dd></div>}
        {change.status !== 'executed' && (
          <div><dt className="inline font-semibold">{expired ? 'Expired' : 'Expires'}: </dt><dd className="inline">{dateTime(change.expires_at)}</dd></div>
        )}
      </dl>

      {change.status === 'executed' && !plan && (
        <div className="rounded-lg p-3 text-[12px] space-y-1" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          {simulated && <p className="font-semibold" style={{ color: 'var(--warning)' }}>{String(change.result?.label ?? 'Demo: simulated')}</p>}
          <p><b>Before:</b> {stateLine(change.before_state)}</p>
          <p><b>After:</b> {stateLine(change.after_state)}</p>
          <p style={{ color: 'var(--text-tertiary)' }}>Applied {dateTime(change.executed_at)}</p>
        </div>
      )}
      {plan && (change.status === 'executed' || change.status === 'failed') && (
        <div data-plan-result={String(change.result?.status ?? change.status)} className="rounded-lg p-3 text-[12px] space-y-1" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          {simulated && <p className="font-semibold" style={{ color: 'var(--warning)' }}>{String(change.result?.label ?? 'Demo: simulated')}</p>}
          {typeof change.result?.message === 'string' && <p>{change.result.message}</p>}
          {createdObjects.length > 0 && (
            <p><b>Created (paused):</b> {createdObjects.filter((o) => o.meta_id).map((o) => `${o.kind} ${o.meta_id}`).join(' · ')}</p>
          )}
          {change.executed_at && <p style={{ color: 'var(--text-tertiary)' }}>Applied {dateTime(change.executed_at)}</p>}
        </div>
      )}

      {controls.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {controls.map((control) => (
            <button
              key={control}
              type="button"
              onClick={() => run(control)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold disabled:opacity-60"
              style={{
                minHeight: 44,
                color: control === 'reject' || control === 'rollback' ? 'var(--text-secondary)' : 'var(--on-accent)',
                background: control === 'reject' || control === 'rollback' ? 'var(--bg-subtle)' : armed === control ? 'var(--danger)' : 'var(--success)',
                border: control === 'reject' || control === 'rollback' ? '1px solid var(--border-hover)' : 'none',
              }}
            >
              {control === 'reject' ? <X size={14} /> : control === 'rollback' ? <RotateCcw size={14} /> : <ShieldCheck size={14} />}
              {busy ? 'Working…' : armed === control ? 'Confirm — apply LIVE on Meta' : plan && control === 'execute' && change.status === 'failed' ? 'Resume creation' : CONTROL_LABEL[control]}
            </button>
          ))}
          {armed && (
            <button type="button" onClick={() => setArmed(null)} className="rounded-lg px-3.5 text-[13px] font-semibold"
              style={{ minHeight: 44, color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border-hover)' }}>
              Cancel
            </button>
          )}
        </div>
      )}

      <p className="text-[11.5px]" style={{ color: writeMode === 'on' ? 'var(--danger)' : 'var(--warning)' }}>
        {!hasLineage(change)
          ? 'Historical request with no decision lineage: it can be rejected but never applied.'
          : plan && change.action_type === 'create_campaign_paused' && change.status !== 'executed'
            ? (writeMode === 'demo' ? 'Demo: applying simulates the creation on the sample data. Nothing is sent to Meta.'
              : writeMode === 'on' ? 'Write mode is ON: applying creates these objects in Meta, every one PAUSED. Nothing is activated.'
                : 'Approving records your decision only: writes are off; turn on WRITE_MODE_ENABLED to create the paused objects.')
          : change.status === 'executed'
            ? 'Roll back proposes the inverse change for your approval; it applies nothing by itself.'
          : writeMode === 'demo'
            ? 'Demo: applying runs a simulated executor on the sample data. Nothing is sent to Meta.'
            : writeMode === 'on'
              ? 'Write mode is ON: applying changes Meta live and may spend real money.'
              : change.status === 'approved'
                ? 'Approved — writes are off; turn on WRITE_MODE_ENABLED to apply.'
                : 'Approving records your decision only: writes are off; turn on WRITE_MODE_ENABLED to apply.'}
      </p>
    </article>
  )
}
