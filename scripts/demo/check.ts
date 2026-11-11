/**
 * `npm run demo:check`: start the demo, request the main pages and APIs through the gateway, render
 * the dashboard in a headless browser and check it shows sample numbers, then stop every process.
 * Exit 0 when every check passes. Used to prove "a clean clone reaches a working dashboard on sample
 * data with zero accounts"; run it under a no-network sandbox to prove no account
 * or service is contacted.
 */
import { startDemo } from './start'
import { demoReportingData, type DemoCalendar } from './sample/demo-account'
import { DEMO_DECISION_IDS } from './sample/demo-seed'

interface Probe { path: string; status: number; contains: string[] }

const probes = (calendar: DemoCalendar): Probe[] => {
  const RANGE = `from=${calendar.range.from}&to=${calendar.range.to}`
  return [
  { path: `/dashboard?${RANGE}`, status: 200, contains: ['data-reporting-shell', 'Sample data'] },
  { path: `/performance?${RANGE}`, status: 200, contains: ['data-reporting-shell'] },
  { path: `/creative?${RANGE}`, status: 200, contains: ['data-reporting-shell'] },
  { path: '/creative/copy', status: 200, contains: ['data-copy-studio', 'AI is off.', 'Sample example (demo data, not AI)', 'Window light, by the hour', 'Your existing ads, scored', 'A bright cyc wall, by the hour'] },
  { path: `/reports?${RANGE}`, status: 200, contains: ['data-reporting-shell'] },
  { path: '/settings', status: 200, contains: ['data-reporting-shell'] },
  { path: '/settings/outcomes', status: 200, contains: ['Booking system webhook (sample)', 'Spring sales export (sample)'] },
  { path: '/settings/outcomes/import', status: 200, contains: ['data-reporting-shell'] },
  { path: '/setup', status: 200, contains: ['Setup checklist', 'Demo mode', 'data-setup-checklist', 'Sample data (no Meta connection in demo)'] },
  { path: `/api/segments?dimension=age&${RANGE}`, status: 200, contains: ['"25-34"', '"metrics_status":"available"'] },
  { path: '/api/competitors', status: 200, contains: ['Brooklyn Loft Studio (sample)'] },
  { path: `/api/reporting?section=meta&${RANGE}`, status: 200, contains: ['"state":"available"', 'Sample data'] },
  { path: `/api/reporting?section=business&${RANGE}`, status: 200, contains: ['"state":"available"'] },
  { path: `/api/reporting?section=website&${RANGE}`, status: 200, contains: ['"section":"website"'] },
  { path: `/api/reporting?section=measurement&${RANGE}`, status: 200, contains: ['"section":"measurement"'] },
  { path: '/api/outcomes/sources', status: 200, contains: ['"kind":"webhook"', '"enabled":true'] },
  { path: '/api/health', status: 200, contains: ['"sources"'] },
  // Healthy states the sample can honestly drive: Meta delivery covered by a successful sync, spend
  // reconciled across sources, and the sync's own decision-gate record (frozen: the sample has no paid cohort).
  { path: '/campaigns/new', status: 200, contains: ['data-campaign-new', 'AI is off: the template planner drafts it'] },
  { path: '/campaigns/plans', status: 200, contains: ['data-campaign-plans'] },
  { path: '/launch', status: 200, contains: ['data-launch-readiness="ready"', 'Spend and results are synced and complete for the checked window.'] },
  { path: `/api/diagnostics/reconciliation?${RANGE}`, status: 200, contains: ['"status":"aligned"'] },
  { path: '/api/diagnostics/decision-gate', status: 200, contains: ['"status":"recorded"', '"closedBy":["paidCohortPublished"]'] },
  ]
}

/** The headers a browser adds to a fetch() from a page on `pageOrigin`: every mutation below is sent
 *  this way, because the app's same-origin check reads them (a header-less request proves nothing). */
function browserHeaders(pageOrigin: string, site: 'same-origin' | 'same-site' | 'cross-site' = 'same-origin'): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: pageOrigin, 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors' }
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; text: string; location: string | null }> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(180_000), ...init })
  return { status: response.status, text: await response.text(), location: response.headers.get('location') }
}

/** Wait until `next dev` answers through the gateway (the gateway replies 502 while it starts). */
async function waitForApp(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/favicon.ico`, { signal: AbortSignal.timeout(5_000) })).status !== 502) return
    } catch { /* not listening yet */ }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error('The demo app did not start in time.')
}

const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(value) ? 0 : 2 })

async function browserCheck(url: string, sampleImageUrl: string, calendar: DemoCalendar): Promise<string> {
  // The figures the sample account holds for the default range (./sample/demo-account.ts).
  const sample = demoReportingData(calendar.range, calendar)
  const booked = usd(sample.business.data!.metrics.booked_value.current.value as number)
  const spend = usd(sample.meta.data!.metrics.spend.current.value as number)
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: true })
  try {
    // An ordinary browser: no certificate exceptions. The sample creatives must render as a user sees them.
    const page = await browser.newPage()
    const errors: string[] = []
    const console_: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => console_.push(`[${message.type()}] ${message.text()}`))
    // A blocked script or style reports a securitypolicyviolation event (and a console error).
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`)))
    const response = await page.goto(`${url}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    const csp = response?.headers()['content-security-policy'] ?? ''
    if (!/script-src 'self' 'nonce-[A-Za-z0-9+/]+={0,2}' 'strict-dynamic'/.test(csp)) throw new Error(`dashboard CSP has no script nonce: ${csp || '(none)'}`)
    const business = page.getByRole('region', { name: 'Business results', exact: true })
    await business.waitFor({ timeout: 180_000 })
    const advertising = page.getByRole('region', { name: 'Advertising results', exact: true })
    // Same assertion as tests/reporting-browser/interactive-preview-check.mjs: the region's text.
    const shows = async (region: typeof business, needle: string) => {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if ((await region.innerText().catch(() => '')).includes(needle)) return
        await page.waitForTimeout(500)
      }
      throw new Error(`${needle} never appeared`)
    }
    await shows(business, booked)
    // The collapsed Trust line reads positively: every source reporting, Tracking a lower bound by design.
    const trust = page.locator('#reporting-trust [data-sources-healthy]')
    await trust.filter({ hasText: 'All 4 sources reporting' }).waitFor({ timeout: 120_000 })
    await shows(advertising, spend)
    // Both overview charts draw a column for every day, and the daily MER has values: no "evidence unavailable".
    const days = sample.meta.data!.series.length
    await page.waitForFunction((count) => ['business', 'meta'].every((kind) =>
      document.querySelectorAll(`[data-overview-chart="${kind}"] rect[data-series="current"]`).length === count), days, { timeout: 120_000 })
    const page_ = await page.locator('#main-content').innerText()
    if (page_.includes('daily evidence unavailable')) throw new Error('an overview chart says its daily evidence is unavailable')
    const mer = await page.locator('[aria-label="Daily MER values"] [role="listitem"]').allInnerTexts()
    if (mer.length !== days || mer.some((cell) => !/\d×/.test(cell))) throw new Error(`Daily MER is not filled: ${mer.slice(0, 5).join(' | ')}`)
    // The sample creatives' image is served on the page's own origin: it must actually render, not just avoid the CSP.
    await page.waitForFunction((src) => [...document.images].some((image) => image.src === src && image.complete && image.naturalWidth > 0),
      sampleImageUrl, { timeout: 120_000 })
    // The browser's own fetch sets Origin and Sec-Fetch-Site itself: this is the request a click sends.
    const scoredInPage = await page.evaluate(async () => {
      const reply = await fetch('/api/creative/copy/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Book a bright room by the hour.' }) })
      return { status: reply.status, text: await reply.text() }
    })
    if (scoredInPage.status !== 200 || !scoredInPage.text.includes('"score"')) throw new Error(`the page's own POST /api/creative/copy/score returned ${scoredInPage.status}: ${scoredInPage.text.slice(0, 120)}`)
    const scripts = await page.locator('script').evaluateAll((nodes) => nodes.map((node) => ({ nonce: (node as HTMLScriptElement).nonce, src: (node as HTMLScriptElement).src })))
    // Every CSP violation fails the check: the sample creatives are served on the page's origin (see ./media.ts).
    const violations = console_.filter((line) => line.includes('CSP violation:'))
    console.log(`browser console (${console_.length} messages):${console_.map((line) => `\n  ${line.slice(0, 300)}`).join('')}`)
    if (errors.length > 0) throw new Error(`Browser errors: ${errors.join('; ')}`)
    const consoleErrors = console_.filter((line) => line.startsWith('[error]'))
    if (consoleErrors.length > 0) throw new Error(`Console errors: ${consoleErrors.join('; ')}`)
    if (violations.length > 0) throw new Error(`CSP violations: ${violations.join('; ')}`)
    // Scripts added at runtime by an already-trusted script run under 'strict-dynamic' without a nonce.
    const stamped = scripts.filter((script) => script.nonce).length
    return `dashboard rendered and hydrated under a nonce CSP: Trust reads "${await trust.innerText()}"; Business results show ${booked} booked value, Advertising results show ${spend} spend; both overview charts and the daily MER filled for ${days} days; ${stamped} of ${scripts.length} script elements carry the nonce; sample creative image rendered from ${sampleImageUrl} without a certificate exception; the page's own POST /api/creative/copy/score scored (200); no CSP violation, no browser errors`
  } finally {
    await browser.close()
  }
}

/** ADR-059 in the demo: propose a change from a seeded decision, approve it, and see the simulated
 *  result and its audit on Changes and Activity. Nothing reaches Meta (the demo has no Meta). */
async function ownerChangeLoop(url: string): Promise<string[]> {
  const json = browserHeaders(url)
  const page = await fetchText(`${url}/changes`)
  console.log(`GET /changes -> ${page.status}`)
  if (page.status !== 200 || !page.text.includes('data-proposable-decision') || !page.text.includes('DEMO')) return ['/changes does not offer the seeded decisions']
  const proposed = await fetchText(`${url}/api/changes`, { method: 'POST', headers: json, body: JSON.stringify({ action_decision_id: DEMO_DECISION_IDS.pause }) })
  const proposal = JSON.parse(proposed.text || '{}') as { status?: string; change_request_id?: string }
  console.log(`POST /api/changes -> ${proposed.status} ${proposal.status}`)
  if (proposed.status !== 201 || !proposal.change_request_id) return ['proposing the seeded pause failed']
  const applied = await fetchText(`${url}/api/changes/${proposal.change_request_id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ action: 'approve_and_apply' }) })
  const result = JSON.parse(applied.text || '{}') as { status?: string; message?: string }
  console.log(`PATCH /api/changes/${proposal.change_request_id} -> ${applied.status} ${result.status}: ${result.message ?? ''}`)
  if (applied.status !== 200 || result.status !== 'DEMO_SIMULATED' || !result.message?.startsWith('Demo: simulated')) return ['approving the proposal did not run the simulated executor']
  const after = await fetchText(`${url}/changes`)
  const activity = await fetchText(`${url}/activity/change-log`)
  console.log(`GET /changes (after) -> ${after.status}; GET /activity/change-log -> ${activity.status}`)
  const failures: string[] = []
  if (!after.text.includes('Demo: simulated')) failures.push('/changes does not show the simulated result')
  if (!activity.text.includes('your change')) failures.push('/activity/change-log does not show the owner change')
  return failures
}

/** ADR-062 in the demo: draft a campaign plan (AI off: the template planner), submit it, approve it on
 *  /changes, and see the simulated PAUSED creation on the plan. Nothing reaches Meta. */
async function campaignPlanLoop(url: string): Promise<string[]> {
  const json = browserHeaders(url)
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const drafted = await fetchText(`${url}/api/campaigns/plans`, { method: 'POST', headers: json, body: JSON.stringify({
    goal: 'traffic', product: 'Daylight studio rental', daily_budget: 20, countries: ['US'], start_date: tomorrow,
  }) })
  const plan = JSON.parse(drafted.text || '{}') as { plan_id?: string; version_id?: string; ok?: boolean; source?: string; validation?: Array<{ severity: string; message: string }> }
  console.log(`POST /api/campaigns/plans -> ${drafted.status} (${plan.source ?? 'no source'}, ok=${String(plan.ok)})`)
  if (drafted.status !== 201 || !plan.plan_id || !plan.version_id) return ['drafting a campaign plan failed']
  if (!plan.ok) return [`the drafted plan has blockers: ${(plan.validation ?? []).filter((i) => i.severity === 'blocker').map((i) => i.message).join(' | ')}`]
  const draftPage = await fetchText(`${url}/campaigns/plans/${plan.plan_id}`)
  console.log(`GET /campaigns/plans/${plan.plan_id} -> ${draftPage.status}`)
  if (draftPage.status !== 200 || !draftPage.text.includes('data-plan-status="draft"') || !draftPage.text.includes('data-plan-readiness')) return ['the drafted plan page did not render']
  const submit = (confirm: boolean) => fetchText(`${url}/api/campaigns/plans/${plan.plan_id}/submit`, { method: 'POST', headers: json, body: JSON.stringify({ version_id: plan.version_id, confirm_budget_step: confirm }) })
  let submitted = await submit(false)
  if (submitted.status === 409 && submitted.text.includes('STEP_LIMIT_EXCEEDED')) submitted = await submit(true)
  const request = JSON.parse(submitted.text || '{}') as { change_request_id?: string; preview?: string }
  console.log(`POST /api/campaigns/plans/${plan.plan_id}/submit -> ${submitted.status}`)
  if (submitted.status !== 201 || !request.change_request_id || !request.preview?.includes('PAUSED')) return ['submitting the plan did not create a change request']
  const applied = await fetchText(`${url}/api/changes/${request.change_request_id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ action: 'approve_and_apply' }) })
  const result = JSON.parse(applied.text || '{}') as { status?: string; message?: string }
  console.log(`PATCH /api/changes/${request.change_request_id} -> ${applied.status} ${result.status}`)
  if (applied.status !== 200 || result.status !== 'DEMO_SIMULATED' || !result.message?.startsWith('Demo: simulated')) return ['approving the plan did not run the simulated creation']
  const after = await fetchText(`${url}/campaigns/plans/${plan.plan_id}`)
  const failures: string[] = []
  if (!after.text.includes('data-plan-status="created_paused"')) failures.push('the plan does not show created_paused')
  if (!after.text.includes('Demo: simulated') || !after.text.includes('data-plan-objects')) failures.push('the plan does not show the simulated paused objects')
  return failures
}

/** The demo must not weaken the same-origin rule: a page on another origin (or one claiming to be
 *  cross-site) is refused by the app even though the gateway allows the route. */
async function crossOriginRefused(url: string, body: string): Promise<string[]> {
  const failures: string[] = []
  const attempts: Array<[string, Record<string, string>]> = [
    ['cross-site Origin', browserHeaders('https://attacker.example', 'cross-site')],
    ['foreign Origin without Sec-Fetch-Site', { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }],
    ['same-site sibling', browserHeaders('http://localhost:1', 'same-site')],
  ]
  for (const [label, headers] of attempts) {
    const refused = await fetchText(`${url}/api/creative/copy/score`, { method: 'POST', headers, body })
    console.log(`POST /api/creative/copy/score (${label}) -> ${refused.status}`)
    if (refused.status !== 403 || !refused.text.includes('Cross-origin mutation is forbidden')) failures.push(`a ${label} mutation was not refused`)
  }
  return failures
}

/** A browser that opens http://localhost:<port> lands on the canonical origin (APP_URL), where its saves
 *  pass the same-origin check; a mutation sent to the other host name is refused, not redirected. */
async function localhostSentToCanonical(url: string, body: string): Promise<string[]> {
  const local = url.replace('//127.0.0.1:', '//localhost:')
  const page = await fetchText(`${local}/creative/copy?tab=1`)
  console.log(`GET ${local}/creative/copy -> ${page.status} ${page.location}`)
  const failures: string[] = []
  if (page.status !== 307 || page.location !== `${url}/creative/copy?tab=1`) failures.push('localhost was not redirected to the canonical origin')
  const write = await fetchText(`${local}/api/creative/copy/score`, { method: 'POST', headers: browserHeaders(local), body })
  console.log(`POST ${local}/api/creative/copy/score -> ${write.status}`)
  if (write.status !== 421) failures.push('a mutation sent to localhost was not refused')
  return failures
}

async function main(): Promise<number> {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3300
  const demo = await startDemo(port, () => {})
  const failures: string[] = []
  try {
    await waitForApp(demo.url)
    const root = await fetchText(`${demo.url}/`)
    console.log(`GET / -> ${root.status} ${root.location}`)
    if (root.status !== 302 || !root.location?.startsWith('/dashboard')) failures.push('/ does not open the dashboard')
    for (const probe of probes(demo.calendar)) {
      const result = await fetchText(`${demo.url}${probe.path}`)
      const missing = probe.contains.filter((needle) => !result.text.includes(needle))
      console.log(`GET ${probe.path} -> ${result.status} (${result.text.length} bytes)${missing.length ? ` missing: ${missing.join(', ')}` : ''}`)
      if (result.status !== probe.status || missing.length > 0) failures.push(probe.path)
    }
    failures.push(...await ownerChangeLoop(demo.url))
    failures.push(...await campaignPlanLoop(demo.url))
    const write = await fetchText(`${demo.url}/api/sync`, { method: 'POST' })
    console.log(`POST /api/sync -> ${write.status} (read-only demo)`)
    if (write.status !== 405) failures.push('POST /api/sync was not refused')
    // Copy studio: scoring is deterministic and allowed in the demo; generating (AI off) and saving are not.
    const copy = JSON.stringify({ text: 'Shooting products this week? Book a bright room by the hour.' })
    const scored = await fetchText(`${demo.url}/api/creative/copy/score`, { method: 'POST', headers: browserHeaders(demo.url), body: copy })
    console.log(`POST /api/creative/copy/score -> ${scored.status} (${scored.text.slice(0, 80)})`)
    if (scored.status !== 200 || !scored.text.includes('"score"')) failures.push('POST /api/creative/copy/score did not score')
    failures.push(...await crossOriginRefused(demo.url, copy))
    failures.push(...await localhostSentToCanonical(demo.url, copy))
    const generated = await fetchText(`${demo.url}/api/creative/copy/generate`, { method: 'POST', body: '{}' })
    console.log(`POST /api/creative/copy/generate -> ${generated.status} (read-only demo)`)
    if (generated.status !== 405) failures.push('POST /api/creative/copy/generate was not refused')
    if (!process.argv.includes('--no-browser')) {
      try { console.log(await browserCheck(demo.url, demo.sampleImageUrl, demo.calendar)) } catch (error) { failures.push(`browser: ${error instanceof Error ? error.message : String(error)}`) }
    }
  } finally {
    await demo.stop()
  }
  console.log(failures.length === 0 ? 'Demo check passed; all demo processes stopped.' : `Demo check FAILED: ${failures.join('; ')}`)
  return failures.length === 0 ? 0 : 1
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
