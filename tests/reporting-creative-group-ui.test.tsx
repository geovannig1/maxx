import React from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { CreativeGroupPanel } from '@/components/reporting/CreativeGroupPanel'
import { investigationHref } from '@/components/reporting/MetricTable'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { creativeAd, creativeContext, creativeData, creativeHistory, emptyCreativeSection } from './fixtures/reporting-creative'
import type { ReportingData } from '@/lib/reporting/contracts'

const query = new URLSearchParams('from=2026-09-02&to=2026-09-04&campaign=101&status=ACTIVE&grouping=creative&group=clicks')
const href = (changes: Record<string, string | null>) => investigationHref('/creative', query, changes)
const render = (data = creativeData(), props = {}) => renderToStaticMarkup(<CreativeGroupPanel data={data}
  entities={data.meta.data?.entities ?? []} group="clicks" href={href} {...props} />)

describe('shared creative reading path', () => {
  it('shows the exact cohort, weighted current/prior calculation, native clock and scoped per-ad links', () => {
    const data = creativeData()
    const html = render({ ...data, context: { ...data.context, asOf: '2026-09-05T18:00:00Z' } })
    expect(html).toContain('2 selected executions')
    expect(html).toContain('2 assigned')
    expect(html).toContain('0 unassigned')
    expect(html).toContain('Creative object 401')
    expect(html).toContain('1.0%')
    expect(html).toContain('$100.00')
    expect(html).toContain('Previous')
    expect(html).toContain(creativeContext.asOf)
    expect(html).toContain('Current configuration preview')
    expect(html).toContain('aria-label="Video creative: Creative 401"')
    expect(html).toContain('Historical object membership')
    expect(html).toContain(href({ ad: '301', view: null }).replaceAll('&', '&amp;'))
    expect(html).toContain('Ad 302')
    expect(html).toContain('Export all group evidence')
    expect(html).toContain('independent of the visible metric tab')
    expect(html).not.toContain(data.meta.data!.entities[0].metrics.clicks.current.claimId)
  })

  it('sorts groups by their total rather than the first execution and retains every group', () => {
    const ads = [creativeAd('301', { spend: '100' }, undefined, '402'),
      creativeAd('302', { spend: '80' }), creativeAd('303', { spend: '80' }),
      ...Array.from({ length: 23 }, (_, index) => creativeAd(String(304 + index), { spend: '0' }, undefined, String(403 + index)))]
    const html = render(creativeData(ads), { sortKey: 'spend', direction: 'desc' })
    expect(html.indexOf('data-creative-id="401"')).toBeLessThan(html.indexOf('data-creative-id="402"'))
    expect(html.match(/data-creative-id=/g)).toHaveLength(25)
    expect(html).toContain('Ad 326')
    const ascending = render(creativeData(ads), { sortKey: 'spend', direction: 'asc' })
    expect(ascending.indexOf('data-creative-id="402"')).toBeLessThan(ascending.indexOf('data-creative-id="401"'))
  })

  it('keeps unassigned names and native ad links discoverable without inventing groups', () => {
    const data = creativeData(undefined, null), html = render(data)
    expect(html).toContain('Unassigned executions')
    expect(html).toContain('Ad 301')
    expect(html).toContain('Ad 302')
    expect(html).toContain('Assignment history is unavailable')
    expect(html).toContain('ad=302')
    expect(html).not.toContain('data-creative-id=')
    expect(html).toContain('0 assigned')
    expect(html).toContain('2 unassigned')
  })

  it('distinguishes unavailable population, a valid empty filter, observed zero and missing measures', () => {
    const unavailable = render({ ...creativeData(), meta: emptyCreativeSection })
    expect(unavailable).toContain('Population could not be established')
    expect(unavailable).not.toContain('0 selected executions')
    expect(render(creativeData(), { entities: [] })).toContain('0 selected executions')
    const zero = render(creativeData([creativeAd('301', { spend: '0', clicks: '0', impressions: '10' })]))
    expect(zero).toContain('$0.00')
    expect(zero).toContain('0.0%')
    expect(zero).toContain('Unavailable')
    const missing = render(creativeData([creativeAd('301', {})]))
    expect(missing).not.toContain('$0.00')
  })

  it('does not show a changed current creative as the historical object preview or claim compatible prior membership', () => {
    const ad = creativeAd('301', { spend: '10' }, undefined, '402')
    const history = creativeHistory([ad])
    const currentOnly = { ...history, observations: history.observations.map((row, index) => ({ ...row,
      metaCreativeId: '401', observedAt: index === 0 ? '2026-09-02T03:59:59.999Z' : row.observedAt })) }
    const html = render(creativeData([ad], currentOnly))
    expect(html).toContain('Creative object 401')
    expect(html).toContain('Current creative: 402')
    expect(html).toContain('No matching current preview')
    expect(html).not.toContain('https://example.test/video.mp4')
    expect(html).toContain('Previous membership is not established for the same executions')
  })

  it('keeps missing group values last in both directions and qualifies stale previous evidence', () => {
    const old = creativeAd('301', { spend: '10' })
    const metric = old.metrics.spend
    const ad = { ...old, metrics: { ...old.metrics, spend: { ...metric,
      previous: { ...metric.previous!, freshness: { ...metric.previous!.freshness, state: 'stale' as const } } } } }
    const data = creativeData([ad, creativeAd('302', {}, undefined, '402')])
    for (const direction of ['asc', 'desc']) {
      const html = render(data, { sortKey: 'spend', direction })
      expect(html.indexOf('data-creative-id="401"')).toBeLessThan(html.indexOf('data-creative-id="402"'))
      expect(html).toContain('Previous: Some native source evidence is stale.')
    }
  })

  it('places current/prior performance before expandable execution and assignment evidence', () => {
    const html = render()
    expect(html.indexOf('aria-label="Spend"')).toBeLessThan(html.indexOf('<h4 class="text-sm font-semibold">Historical object membership'))
    expect(html).toContain('aria-label="Executions and assignment evidence"')
  })
})

// Exercise the shipped component and worker entry in a real browser without an app server.
// Only Next navigation and the bundler's worker URL resolution are adapted to this Blob harness.
describe.runIf(process.env.REPORTING_CREATIVE_UI_BROWSER === '1')('shared creative browser interaction', () => {
let browser: Browser, componentScript: string, workerScript: string
beforeAll(async () => {
  const shared = { bundle: true, write: false as const, platform: 'browser' as const, format: 'iife' as const,
    alias: { '@': resolve('src') }, jsx: 'automatic' as const,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"https://fixture.test/components.js"' } }
  const worker = await build({ ...shared, entryPoints: ['src/components/reporting/creative-group-export.worker.ts'] })
  workerScript = worker.outputFiles[0].text
  const component = await build({ ...shared, stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {CreativeGroupPanel} from './src/components/reporting/CreativeGroupPanel';
    const root=createRoot(document.getElementById('root'));
    window.showPanel=(data,ids,group='clicks')=>{window.activeData=data;flushSync(()=>root.render(<CreativeGroupPanel data={data}
      entities={data.meta.data.entities.filter(ad=>!ids||ids.includes(ad.id))} group={group}
      href={changes=>'/creative?from=2026-09-02&to=2026-09-04&ad='+changes.ad}/>));};
    window.selectAds=ids=>window.showPanel(window.activeData,ids);
    window.unmountPanel=()=>flushSync(()=>root.unmount());
  ` }, plugins: [{ name: 'next-browser-fixture', setup(builder) {
    builder.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: 'fixture-next' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, args => ({ loader: 'js', resolveDir: process.cwd(), contents:
      args.path === 'next/link' ? "import{createElement}from'react';export default function Link({scroll,children,...props}){return createElement('a',props,children)}"
        : "export const usePathname=()=>'/creative';export const useSearchParams=()=>new URLSearchParams();" }))
  } }] })
  componentScript = component.outputFiles[0].text
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => { await browser?.close() })

async function pageFor(data: ReportingData): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(10_000)
  await page.route('https://example.test/**', route => route.abort())
  await page.setContent('<div id="root"></div>')
  await page.evaluate(script => {
    const state = window as unknown as { downloads: Blob[]; terminated: number; ticks: number; activeWorkers: number; longestGap: number }
    state.downloads = []; state.terminated = 0; state.ticks = 0; state.activeWorkers = 0; state.longestGap = 0
    const workerUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' })), NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor() { super(workerUrl); state.activeWorkers++ }
      terminate() { super.terminate(); state.terminated++; state.activeWorkers-- }
    }
    const createUrl = URL.createObjectURL.bind(URL)
    URL.createObjectURL = blob => { if (blob instanceof Blob && blob.type.includes('csv')) state.downloads.push(blob); return createUrl(blob) }
    HTMLAnchorElement.prototype.click = function () { /* local download observed through the actual Blob */ }
    let lastTick = performance.now()
    setInterval(() => { const now = performance.now(); state.ticks++; state.longestGap = Math.max(state.longestGap, now - lastTick); lastTick = now }, 10)
  }, workerScript)
  await page.addScriptTag({ content: componentScript })
  await page.evaluate(data => (window as unknown as { showPanel: (data: ReportingData) => void }).showPanel(data), data)
  return page
}

it('opens exact native inputs by keyboard, exports all metrics in a real worker, and keeps the page responsive', async () => {
  const data = creativeData(Array.from({ length: 50 }, (_, i) => creativeAd(String(301 + i), { spend: '10', clicks: '1', impressions: '100' })))
  const page = await pageFor(data)
  try {
    const members = page.locator('summary[aria-label="Executions and assignment evidence"]')
    expect(await page.getByRole('link', { name: 'Ad 350', exact: true }).count()).toBe(0)
    await members.focus(); await page.keyboard.press('Enter')
    expect(await page.getByRole('link', { name: 'Ad 350', exact: true }).getAttribute('href')).toContain('ad=350')
    await members.click()
    const input = page.getByRole('button', { name: 'Inputs for All-click CTR', exact: true })
    expect(await page.locator('[data-native-input]').count()).toBe(0)
    await input.focus(); await page.keyboard.press('Enter')
    await page.waitForSelector('[data-native-input]')
    expect(await page.getByText('/meta/data/entities/0/metrics/clicks', { exact: true }).count()).toBe(2)
    expect(await page.getByText('1.0%', { exact: true }).count()).toBeGreaterThan(0)
    await page.getByText('Exact native metric and claim', { exact: true }).first().click()
    expect(await page.locator('pre').first().textContent()).toContain(data.meta.data!.entities[0].metrics.clicks.current.claimId)
    await input.click()
    expect(await page.locator('[data-native-input]').count()).toBe(0)
    const started = Date.now()
    const ticks = await page.evaluate(() => { const state = window as unknown as { ticks: number; longestGap: number }; state.longestGap = 0; return state.ticks })
    await page.getByRole('button', { name: 'Export all group evidence', exact: true }).click()
    await page.waitForFunction(() => (window as unknown as { downloads: Blob[] }).downloads.length === 1, undefined, { timeout: 30_000 })
    const result = await page.evaluate(async () => {
      const state = window as unknown as { downloads: Blob[]; ticks: number; activeWorkers: number; longestGap: number }
      const csv = await state.downloads[0].text()
      return { csvHasRetention: csv.includes('retention_p100'), csvHasInput: csv.includes('/meta/data/entities/49/metrics/clicks'),
        csvHasMembers: csv.includes('Ad 350'), bytes: state.downloads[0].size, ticks: state.ticks, active: state.activeWorkers, longestGap: state.longestGap }
    })
    expect(result.csvHasRetention).toBe(true)
    expect(result.csvHasInput).toBe(true)
    expect(result.csvHasMembers).toBe(true)
    expect(result.bytes).toBeGreaterThan(10_000)
    expect(result.ticks - ticks).toBeGreaterThan(5)
    expect(result.active).toBe(0)
    process.stdout.write(`Creative export browser observation: ${JSON.stringify({ ads: 50, elapsedMs: Date.now() - started, bytes: result.bytes, timerTicks: result.ticks - ticks, longestTimerGapMs: result.longestGap })}\n`)
  } finally { await page.close() }
})

it('cancels exports on explicit cancellation, filter replacement and unmount without stale downloads', async () => {
  const data = creativeData(Array.from({ length: 35 }, (_, i) => creativeAd(String(301 + i), { spend: '10' })))
  const page = await pageFor(data)
  try {
    await page.getByRole('button', { name: 'Export all group evidence', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel export', exact: true }).click()
    expect(await page.evaluate(() => (window as unknown as { activeWorkers: number }).activeWorkers)).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { downloads: Blob[] }).downloads.length)).toBe(0)
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Export all group evidence')!.click()
      ;(window as unknown as { selectAds: (ids: string[]) => void }).selectAds(['301'])
    })
    expect(await page.evaluate(() => (window as unknown as { activeWorkers: number }).activeWorkers)).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { downloads: Blob[] }).downloads.length)).toBe(0)
    expect(await page.getByText('1 selected executions', { exact: false }).count()).toBe(1)
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Export all group evidence')!
      button.click()
      ;(window as unknown as { unmountPanel: () => void }).unmountPanel()
    })
    expect(await page.evaluate(() => (window as unknown as { activeWorkers: number }).activeWorkers)).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { downloads: Blob[] }).downloads.length)).toBe(0)
  } finally { await page.close() }
})

it('the actual worker rejects altered calculations instead of producing a CSV', async () => {
  const result = buildCreativeGroups(creativeData())
  result.groups[0].metrics.ctr.current.value = 99
  const page = await browser.newPage()
  try {
    const response = await page.evaluate(({ script, result, context }) => new Promise(resolve => {
      const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' })), worker = new Worker(url)
      worker.onmessage = event => { resolve(event.data); worker.terminate(); URL.revokeObjectURL(url) }
      worker.postMessage({ result, context, keys: ['ctr'] })
    }), { script: workerScript, result, context: creativeContext })
    expect(response).toEqual({ ok: false })
  } finally { await page.close() }
})

it('terminates a timed-out worker, reports a retryable failure and supports a fresh export', async () => {
  const page = await pageFor(creativeData())
  try {
    await page.evaluate(() => {
      const nativeTimeout = window.setTimeout.bind(window)
      let expire: (() => void) | null = null
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 60_000 && typeof callback === 'function') expire = () => callback()
        return nativeTimeout(callback, delay, ...args)
      }) as typeof window.setTimeout
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Export all group evidence')!.click()
      if (!expire) throw new Error('Export did not install its finite timeout')
      ;(expire as () => void)()
      window.setTimeout = nativeTimeout
    })
    expect(await page.getByRole('status').filter({ hasText: 'could not be prepared' }).count()).toBe(1)
    expect(await page.evaluate(() => (window as unknown as { activeWorkers: number }).activeWorkers)).toBe(0)
    await page.getByRole('button', { name: 'Export all group evidence', exact: true }).click()
    await page.waitForFunction(() => (window as unknown as { downloads: Blob[] }).downloads.length === 1)
    expect(await page.getByRole('status').filter({ hasText: 'download prepared' }).count()).toBe(1)
  } finally { await page.close() }
})

it('retains an active export across metric tabs and unrelated source completion with the same Meta scope', async () => {
  const page = await pageFor(creativeData())
  try {
    const observed = await page.evaluate(() => {
      const state = window as unknown as { activeData: ReportingData; activeWorkers: number;
        showPanel: (data: ReportingData, ids?: string[], group?: string) => void }
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Export all group evidence')!.click()
      const started = state.activeWorkers
      state.showPanel(state.activeData, undefined, 'results')
      const afterTab = state.activeWorkers, data = state.activeData
      state.showPanel({ ...data, context: { ...data.context, account: { ...data.context.account },
        range: { ...data.context.range }, comparison: { ...data.context.comparison }, asOf: '2026-09-05T18:00:00Z' },
        business: { ...data.business, asOf: '2026-09-05T18:00:00Z' }, website: { ...data.website, asOf: '2026-09-05T18:00:00Z' } }, undefined, 'results')
      return { started, afterTab, afterOtherSources: state.activeWorkers,
        status: document.querySelector('[role="status"][aria-live="polite"]')?.textContent }
    })
    expect(observed.started).toBe(1)
    expect(observed.afterTab).toBe(1)
    expect(observed.afterOtherSources).toBe(1)
    expect(observed.status).toContain('Preparing evidence')
    await page.waitForFunction(() => (window as unknown as { downloads: Blob[] }).downloads.length === 1)
    const csv = await page.evaluate(async () => (window as unknown as { downloads: Blob[] }).downloads[0].text())
    expect(csv).toContain(creativeContext.asOf)
    expect(csv).not.toContain('2026-09-05T18:00:00Z')
    expect(csv).toContain('retention_p100')
  } finally { await page.close() }
})

it.each(['meta', 'selection', 'date', 'account'])('still cancels an active export when %s evidence or scope changes', async change => {
  const page = await pageFor(creativeData())
  try {
    const observed = await page.evaluate(change => {
      const state = window as unknown as { activeData: ReportingData; activeWorkers: number; downloads: Blob[];
        showPanel: (data: ReportingData, ids?: string[]) => void }
      const data = state.activeData
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Export all group evidence')!.click()
      const started = state.activeWorkers
      if (change === 'selection') state.showPanel(data, ['301'])
      else if (change === 'meta') state.showPanel({ ...data, meta: { ...data.meta, notes: ['A new Meta source observation.'] } })
      else if (change === 'date') state.showPanel({ ...data, context: { ...data.context,
        range: { from: '2026-09-01', to: '2026-09-03' }, comparison: { from: '2026-08-29', to: '2026-08-31' } } })
      else state.showPanel({ ...data, context: { ...data.context, account: { ...data.context.account, metaAccountId: 'act_999' } } })
      return { started, afterChange: state.activeWorkers, downloads: state.downloads.length }
    }, change)
    expect(observed).toEqual({ started: 1, afterChange: 0, downloads: 0 })
  } finally { await page.close() }
})
})
