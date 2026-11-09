import { expect, test, type Page, type Route } from '@playwright/test'
import { fixtureCookie } from './auth-fixture.mjs'
import { fixturePacket } from '../../scripts/demo/sample/reports'

type Mode = 'ok' | 'failed' | 'denied' | 'hang'
async function sourceControl(page: Page) {
  const modes: Record<string, Mode> = { meta: 'ok', business: 'ok', website: 'ok', measurement: 'ok' }
  const held: Route[] = []
  await page.route('**/api/**', async route => {
    expect(route.request().method()).toBe('GET')
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/reporting') { await route.fulfill({ json: {} }); return }
    const section = url.searchParams.get('section') ?? 'meta'
    if (modes[section] === 'hang') { held.push(route); return }
    if (modes[section] === 'failed' || modes[section] === 'denied') {
      await route.fulfill({ status: modes[section] === 'denied' ? 401 : 503, json: { error: 'Controlled failure' } })
      return
    }
    await route.fulfill({ json: fixturePacket(section, url.searchParams.get('from')!, url.searchParams.get('to')!) })
  })
  await page.route('https://example.test/**', route => route.fulfill({ status: 404, body: 'Unavailable fixture asset' }))
  return { modes, held }
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'sb-127-auth-token', value: fixtureCookie, domain: '127.0.0.1', path: '/', sameSite: 'Lax' }])
})

test('refresh retains matching results until replacement, with explicit refresh failure and original age', async ({ page }) => {
  const control = await sourceControl(page)
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  const advertising = page.getByRole('region', { name: 'Advertising results' })
  await expect(advertising).toContainText('$120.00')
  control.modes.meta = 'hang'
  await page.getByRole('button', { name: 'Refresh Meta advertising' }).click()
  await expect.poll(() => control.held.length).toBe(1)
  await expect(advertising).toContainText('$120.00')
  const source = page.getByLabel('Reporting source status').locator('> div').filter({ hasText: 'Meta advertising' })
  await expect(source).toContainText('Refreshing')
  await control.held[0].fulfill({ status: 503, json: { error: 'Controlled refresh failure' } })
  await expect(source).toContainText('Refresh failed')
  await expect(advertising).toContainText('$120.00')
  await page.getByLabel('Meta advertising source details').click()
  await expect(source).toContainText('2026-09-05T17:00:00Z')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  control.modes.meta = 'ok'
  await page.getByRole('button', { name: 'Refresh Meta advertising' }).click()
  await expect(source).toContainText('Available')
  await expect(source).not.toContainText('Refresh failed')
})

test('all-source failure terminates account resolution and has a working retry', async ({ page }) => {
  const control = await sourceControl(page)
  for (const section of Object.keys(control.modes)) control.modes[section] = 'failed'
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  await expect(page.getByText('Reporting could not load. Inspect source details above and retry.')).toBeVisible()
  await expect(page.getByText('Resolving reporting account…')).toHaveCount(0)
  await expect(page.getByText('Reporting account unavailable')).toBeVisible()
  for (const section of Object.keys(control.modes)) control.modes[section] = 'ok'
  await page.getByRole('button', { name: 'Retry reports' }).click()
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
})

test('a hung source reaches a bounded error while healthy business results remain visible', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-05T17:00:00Z') })
  const control = await sourceControl(page)
  control.modes.meta = 'hang'
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  await expect.poll(() => control.held.length).toBe(1)
  await page.clock.fastForward(120_001)
  const source = page.getByLabel('Reporting source status').locator('> div').filter({ hasText: 'Meta advertising' })
  await expect(source).toContainText('Unavailable')
  await page.getByLabel('Meta advertising source details').click()
  await expect(source).toContainText('took too long')
  await expect(page.getByRole('button', { name: 'Refresh Meta advertising' })).toBeEnabled()
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  await control.held[0].abort().catch(() => {})
})

test('lost session clears every cached source and offers sign-in without sending an email', async ({ page }) => {
  const control = await sourceControl(page)
  await page.goto('/dashboard?from=2026-09-02&to=2026-09-04')
  await expect(page.getByRole('region', { name: 'Business results' })).toContainText('$500.00')
  control.modes.meta = 'denied'
  await page.getByRole('button', { name: 'Refresh Meta advertising' }).click()
  await expect(page.getByRole('region', { name: 'Business results' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Advertising results' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', /\/login\?next=/)
})
