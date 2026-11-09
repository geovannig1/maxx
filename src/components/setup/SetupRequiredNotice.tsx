import Link from 'next/link'
import type { EnvIssue } from '@/config/env'

// Shown in place of a dashboard page while configuration is incomplete. Lists the
// missing or invalid variables by NAME (never a value) and links to the full checklist.

export function SetupRequiredNotice({ issues }: { issues: EnvIssue[] }) {
  const metaMissing = issues.some((issue) => issue.name.startsWith('META_'))
  return (
    <section data-setup-required aria-labelledby="setup-required" className="mx-auto max-w-2xl space-y-4 rounded-lg border p-6" style={{ borderColor: 'var(--warning)' }}>
      <h1 id="setup-required" className="text-xl font-semibold">Finish setup to open this page</h1>
      <p className="text-sm">Maxx is running, but these settings are missing or invalid:</p>
      <ul className="list-disc space-y-1 pl-6 text-sm">
        {issues.map((issue) => <li key={issue.name}><code>{issue.name}</code>: {issue.message}</li>)}
      </ul>
      {metaMissing ? (
        <p className="text-sm">
          Every page reads the one Meta ad account this install analyses. Outcome sources and CSV import belong to that ad account
          as well, so they open once Meta is connected and the first sync has stored it (<code>npm run sync:manual</code>).
        </p>
      ) : null}
      <p className="text-sm">
        <Link href="/setup" className="underline">Open the setup checklist</Link> for the exact steps and a connection test for each
        integration, or run <code>npm run setup</code>. To look around first, run <code>npm run demo</code> on your machine.
      </p>
    </section>
  )
}

export function DemoBanner() {
  return (
    <p role="status" data-demo-banner className="mb-4 rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--warning)' }}>
      Sample data: a fictional business, no accounts connected. Run <code>npm run setup</code> to use your own.
    </p>
  )
}
