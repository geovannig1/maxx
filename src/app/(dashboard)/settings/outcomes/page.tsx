import Link from 'next/link'
import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { listOutcomeSources, sourceKindNote, type OutcomeSourceRow } from '@/lib/outcomes/source-admin'
import { PageHeader } from '@/components/layout/PageHeader'
import { OutcomeSourceToggle } from '@/components/setup/OutcomeSourceToggle'
import { WebhookSourceCreate } from '@/components/outcomes/WebhookSourceCreate'
import { WebhookSecretRotate } from '@/components/outcomes/WebhookSecretRotate'
import { WEBHOOK_SIGNATURE_FORMAT, WEBHOOK_SIGNATURE_HEADER, webhookPath } from '@/components/outcomes/webhook-secret'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import { sourceCompletenessLabel } from '@/lib/outcomes/completeness-label'

// Outcome sources screen (the v1 release; tracker "enable/disable toggle for an outcome source after
// creation, plus a sources screen"). Owner-only. Shows every source of the active account with its
// kind, last success and an on/off switch. A disabled source's outcomes stay stored and are counted
// nowhere; with no source enabled, reports say "no outcome source", never 0. Webhook sources are
// created and their secrets rotated here; a secret is shown once, in a dialog.

async function readSources(): Promise<OutcomeSourceRow[] | null> {
  try {
    const db = getAdminClient()
    const active = await resolveOnlyActiveAccount(db)
    return active.ok ? await listOutcomeSources(db, active.account.id) : null
  } catch {
    return null
  }
}

// Reconciled sources are checked against their own system; push-only sources count as they arrive.
const completeness = (kind: string) => {
  const adapter = getOutcomeAdapter(kind)
  return sourceCompletenessLabel(adapter?.ledgerHealth || adapter?.reconcile ? 'reconciled' : 'push_as_received', kind)
}

const when = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never')

export default async function OutcomeSourcesPage() {
  await requireOwner()
  const sources = await readSources()
  return (
    <div className="space-y-6">
      <PageHeader title="Outcome sources" subtitle="Where your business results come from. Only enabled sources are counted in reports." />
      <p className="text-sm">
        Add results with a <a className="underline" href="/settings/outcomes/import">CSV import</a> or a signed webhook
        (below). <Link className="underline" href="/setup">Setup checklist</Link>
      </p>
      {sources === null ? (
        <p role="status" className="text-sm">The sources could not be read: connect the database first (see the <Link className="underline" href="/setup">setup checklist</Link>).</p>
      ) : sources.length === 0 ? (
        <p role="status" className="text-sm">No outcome source yet. Reports say &quot;no outcome source&quot; until you add and enable one.</p>
      ) : (
        <ul className="divide-y rounded-lg border" style={{ borderColor: 'var(--border)' }} data-outcome-sources>
          {sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-start justify-between gap-4 p-4" data-source-id={source.id}>
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{source.label} <span className="ml-2 text-xs font-normal uppercase" style={{ color: 'var(--text-tertiary)' }}>{source.kind}</span></p>
                <p className="text-sm">{source.enabled ? `Enabled: counted in reports (${completeness(source.kind)}).` : 'Disabled: stored, counted nowhere.'} Last success {when(source.last_success_at)}.</p>
                {sourceKindNote(source.kind) ? <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{sourceKindNote(source.kind)}</p> : null}
                {source.kind === 'webhook' ? <p className="text-xs">Endpoint: <code className="break-all">POST {webhookPath(source.id)}</code></p> : null}
              </div>
              <div className="flex flex-wrap items-start gap-2">
                {source.kind === 'webhook' ? <WebhookSecretRotate id={source.id} label={source.label} /> : null}
                <OutcomeSourceToggle id={source.id} label={source.label} enabled={source.enabled} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {sources === null ? null : (
        <section aria-labelledby="webhook-create-title" className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
          <h2 id="webhook-create-title" className="text-base font-semibold">Add a signed webhook</h2>
          <p className="text-sm">
            Your system sends one result per request to its endpoint, signed with the source&apos;s secret in the
            header <code>{WEBHOOK_SIGNATURE_HEADER}: {WEBHOOK_SIGNATURE_FORMAT}</code>. The secret is shown once, when
            you create the source or rotate its secret.
          </p>
          <WebhookSourceCreate />
        </section>
      )}
    </div>
  )
}
