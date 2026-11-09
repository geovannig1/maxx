import Link from 'next/link'
import { connection } from 'next/server'
import { requireOwner } from '@/lib/auth/page-owner'
import { setupAccessMode } from '@/lib/setup/access'
import { runChecks } from '@/lib/setup/checks'
import { demoSetupChecks, groupByIntegration } from '@/lib/setup/types'
import { dashboardBlockers } from '@/config/env'
import { isDemoMode } from '@/config/demo'
import { SetupChecklist } from '@/components/setup/SetupChecklist'
import { SetupSettings } from '@/components/setup/SetupSettings'

// The first-run setup checklist. Owner-only once anyone can sign in;
// before that (no Supabase public values, or no OWNER_EMAIL) it shows only the NAMES
// of the missing variables and the steps, never a value (src/lib/setup/access.ts). The page itself
// runs the configuration checks only; network tests run when the owner presses a test button.

function PublicChecklist() {
  const blockers = dashboardBlockers(process.env).filter((issue) => issue.blocks === 'app' || issue.name.startsWith('NEXT_PUBLIC_SUPABASE'))
  return (
    <main id="main-content" className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">Finish setting up Maxx</h1>
      <p>Nobody can sign in yet, so this page shows only which settings are missing. Set them in your host&apos;s environment variables (Vercel: Project → Settings → Environment Variables) or run <code>npm run setup</code> locally, then redeploy.</p>
      <ul className="list-disc space-y-1 pl-6" data-setup-missing>
        {blockers.map((issue) => <li key={issue.name}><code>{issue.name}</code>: {issue.message}</li>)}
      </ul>
      <p>Every variable is described in <code>docs/configuration.md</code>. After sign-in works, this page shows the full checklist with a connection test for each integration.</p>
    </main>
  )
}

export default async function SetupPage() {
  await connection()
  if (setupAccessMode(process.env) === 'public') return <PublicChecklist />
  await requireOwner()
  const demo = isDemoMode()
  const summary = await runChecks(process.env, { fetch }, { offline: true })
  const checks = summary.checks.filter((c) => c.id !== 'network.skipped')
  const groups = groupByIntegration(demo ? demoSetupChecks(checks) : checks)
  const incomplete = !demo && dashboardBlockers(process.env).length > 0
  return (
    <main id="main-content" className="mx-auto max-w-4xl space-y-6 px-4 py-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Setup checklist</h1>
        {demo ? (
          <p role="status" className="rounded-md border p-3 text-sm" style={{ borderColor: 'var(--warning)' }}>
            Demo mode: sample data for a fictional business, no accounts connected. Run <code>npm run setup</code> to use your own.
          </p>
        ) : null}
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          The same checks as <code>npm run doctor</code>. Secrets stay in environment variables and are never shown here.
          {incomplete ? ' The dashboard opens once the failing items below are fixed.' : ' '}
          <Link href="/dashboard" className="underline">Open the dashboard</Link>
        </p>
      </div>
      <SetupChecklist groups={groups} interactive />
      <SetupSettings />
    </main>
  )
}
