'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { CheckLevel, CheckResult, IntegrationGroup, IntegrationId } from '@/lib/setup/types'

// The in-app setup checklist. Each integration shows what is connected, what is
// missing and the exact variable or step. "Test connection" asks /api/setup/checks to run the same
// checks module as `npm run setup` and `npm run doctor`; results never contain a secret.

const LEVEL: Record<CheckLevel, { label: string; color: string }> = {
  ok: { label: 'Connected', color: 'var(--success)' },
  warn: { label: 'Needs attention', color: 'var(--warning)' },
  fail: { label: 'Missing or failing', color: 'var(--danger)' },
  skip: { label: 'Not configured (optional)', color: 'var(--text-tertiary)' },
}

const TESTABLE: ReadonlySet<IntegrationId> = new Set(['supabase', 'owner', 'meta', 'outcomes', 'ai'])

function worst(checks: CheckResult[]): CheckLevel {
  const order: CheckLevel[] = ['fail', 'warn', 'ok', 'skip']
  return order.find((level) => checks.some((c) => c.level === level)) ?? 'skip'
}

function Row({ check }: { check: CheckResult }) {
  return (
    <li className="py-2 text-sm" data-check-id={check.id}>
      <span className="font-medium" style={{ color: LEVEL[check.level].color }}>{check.label ?? LEVEL[check.level].label}</span>
      <span className="mx-2" aria-hidden>·</span>
      <span className="font-medium">{check.title}</span>: {check.detail}
      {check.fix && check.level !== 'ok' && check.level !== 'skip' ? (
        <p className="mt-1 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{check.fix}</p>
      ) : null}
    </li>
  )
}

function Group({ group, interactive }: { group: IntegrationGroup; interactive: boolean }) {
  const [checks, setChecks] = useState(group.checks)
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const level = worst(checks)
  // Every row labelled (demo sample data): show that label, and there is no connection to test.
  const sample = checks.every((c) => c.label) ? checks[0]?.label : undefined

  async function test(live: boolean) {
    setStatus('running')
    try {
      const res = await fetch('/api/setup/checks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integration: group.integration, ...(live ? { live: true } : {}) }),
      })
      if (!res.ok) throw new Error(String(res.status))
      const body = await res.json() as { checks: CheckResult[] }
      setChecks(body.checks.length > 0 ? body.checks : checks)
      setStatus('idle')
    } catch {
      setStatus('error')
    }
  }

  return (
    <section aria-labelledby={`setup-${group.integration}`} className="rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`setup-${group.integration}`} className="text-base font-semibold">
          {group.title} <span className="ml-2 text-sm font-normal" style={{ color: LEVEL[level].color }}>{sample ?? LEVEL[level].label}</span>
        </h2>
        {interactive && !sample && TESTABLE.has(group.integration) ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={status === 'running'} onClick={() => test(false)}>
              {status === 'running' ? 'Testing…' : 'Test connection'}
            </Button>
            {group.integration === 'ai' ? (
              <Button size="sm" variant="ghost" disabled={status === 'running'} onClick={() => test(true)}>Test with one AI call</Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {status === 'error' ? <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>The test could not run. Try again, or run npm run doctor.</p> : null}
      <ul className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
        {checks.map((check) => <Row key={check.id} check={check} />)}
      </ul>
    </section>
  )
}

export function SetupChecklist({ groups, interactive }: { groups: IntegrationGroup[]; interactive: boolean }) {
  return (
    <div className="space-y-4" data-setup-checklist>
      {groups.map((group) => <Group key={group.integration} group={group} interactive={interactive} />)}
    </div>
  )
}
