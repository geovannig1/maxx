import { test, expect, type Page } from '@playwright/test'
import { fixtureCookie } from './auth-fixture.mjs'
import { progressiveGateway } from './progressive-gateway'
import { openReportingTrust, sourceRow } from './source-strip'

let gateway: Awaited<ReturnType<typeof progressiveGateway>>
test.beforeAll(async () => { gateway = await progressiveGateway() })
test.afterAll(async () => { await gateway.close() })
test.beforeEach(async ({ context }) => {
  gateway.reset()
  await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: '127.0.0.1', path: '/', sameSite: 'Lax' }])
})

/** The Meta row of the source strip. On the overview the strip sits inside the collapsed Trust panel. */
async function metaSource(page: Page) {
  await openReportingTrust(page)
  return sourceRow(page, 'Meta advertising')
}

test('governed totals render through real HTTP while optional detail remains open, then complete', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${gateway.url}/dashboard?from=2026-09-02&to=2026-09-04`)
  const advertising = page.getByRole('region', { name: 'Advertising results' })
  await expect(advertising).toContainText('$120.00')
  expect(gateway.held).toHaveLength(1)
  expect(gateway.held[0].response.writableEnded).toBe(false)
  expect(gateway.held[0].accept).toContain('application/x-ndjson')
  const source = await metaSource(page)
  await expect(source).toContainText('Details loading')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  gateway.complete()
  await expect(source).toContainText('Available')
  await expect(advertising).toContainText('$120.00')
  await page.screenshot({ path: 'test-results/reporting-browser/progressive-completed.png', fullPage: true })
  expect(errors).toEqual([])
})

test('an interrupted detail stream retains its visible totals and retries normally', async ({ page }) => {
  await page.goto(`${gateway.url}/dashboard?from=2026-09-02&to=2026-09-04`)
  const advertising = page.getByRole('region', { name: 'Advertising results' })
  await expect(advertising).toContainText('$120.00')
  gateway.held[0].response.end()
  const source = await metaSource(page)
  await expect(source).toContainText('Refresh failed')
  await expect(advertising).toContainText('$120.00')
  await page.getByLabel('Meta advertising source details').click()
  await expect(source).not.toContainText('Optional Meta details, configuration and trends are loading.')
  await page.getByRole('button', { name: 'Refresh Meta advertising' }).click()
  await expect.poll(() => gateway.held.length).toBe(2)
  await expect(advertising).toContainText('$120.00')
  gateway.complete()
  await expect(source).toContainText('Available')
})

test('changing dates cancels the old stream and keeps the next period isolated', async ({ page }) => {
  await page.goto(`${gateway.url}/dashboard?from=2026-09-02&to=2026-09-04`)
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$120.00')
  await page.evaluate(() => window.history.pushState(null, '', '/dashboard?from=2026-08-02&to=2026-08-04'))
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$240.00')
  await expect.poll(() => gateway.held[0].closed).toBe(true)
  gateway.complete(0)
  gateway.complete()
  await expect(page.getByRole('region', { name: 'Advertising results' })).toContainText('$240.00')
  // The account context comes from the new period's packet: Aug 2-4 compares with the 3 days before it.
  await expect(page.getByText('vs Jul 30 – Aug 1', { exact: true })).toBeVisible()
})

test('creative details distinguish loading from absence and survive an unsuccessful detail refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${gateway.url}/creative?from=2026-09-02&to=2026-09-04&ad=ad-1`)
  await expect(page.getByText('Loading preview…', { exact: true })).toBeVisible()
  await expect(page.getByText('Primary text was not supplied by Meta.')).toHaveCount(0)
  gateway.complete()
  await expect(page.getByText('Make room for your next shoot.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh Meta advertising' }).click()
  await expect.poll(() => gateway.held.length).toBe(2)
  await expect(page.getByText('Make room for your next shoot.', { exact: true })).toBeVisible()
  const packet = gateway.held[1].packet
  if (packet.section !== 'meta' || !packet.result.data) throw new Error('Missing fixture data')
  gateway.complete(1, { ...packet, result: { ...packet.result, state: 'partial', data: { ...packet.result.data,
    detailState: 'unavailable', entities: packet.result.data.entities.map(entity => ({ ...entity, creative: null })),
  } } })
  const source = await metaSource(page)
  await expect(source).toContainText('Refresh failed')
  await expect(page.getByText('Make room for your next shoot.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
