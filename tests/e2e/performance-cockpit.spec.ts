import { expect, test } from '@playwright/test'

test.describe('authenticated reporting workspace release gate', () => {
  test.beforeEach(async ({ page }) => {
    const expectedCommitSha = process.env.E2E_EXPECTED_COMMIT_SHA
    if (!expectedCommitSha) throw new Error('E2E_EXPECTED_COMMIT_SHA is required for release E2E.')

    const provenance = await page.request.get('/api/release-provenance')
    expect(provenance.status()).toBe(200)
    await expect(provenance.json()).resolves.toEqual(expect.objectContaining({
      commit_sha: expectedCommitSha,
    }))
  })

  test('keeps business and advertising context, source evidence, and responsive keyboard navigation usable', async ({ page }) => {
    await page.goto('/dashboard?range=mtd', { waitUntil: 'domcontentloaded' })

    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('main')).toBeVisible()
    const business = page.getByRole('region', { name: 'Business results' })
    const advertising = page.getByRole('region', { name: 'Advertising results' })
    await expect(business).toBeVisible({ timeout: 30_000 })
    await expect(business.getByText('Booked value', { exact: true })).toBeVisible()
    await expect(business.getByText('Acuity · All sources', { exact: true })).toBeVisible()
    await expect(advertising.getByText('Reported ROAS', { exact: true })).toBeVisible()
    await expect(advertising.getByLabel('Dashboard result event')).toHaveValue('appointment_confirmed')
    const delivery = page.getByRole('region', { name: 'Account delivery' })
    for (const label of ['Impressions', 'Reach', 'Frequency', 'CPM']) await expect(delivery.getByText(label, { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Creative comparison' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Campaign and ad-set comparison' })).toBeVisible()

    const trust = page.locator('#reporting-trust')
    const trustSummary = trust.locator(':scope > summary')
    await expect(trustSummary).toContainText('Evidence: Meta')
    await trustSummary.focus()
    await page.keyboard.press('Enter')
    await expect(trust).toHaveAttribute('open', '')
    for (const source of ['Meta advertising', 'Acuity business', 'GA4 website', 'Booking links & tracking']) {
      const sourceSummary = trust.getByLabel(`${source} source details`, { exact: true })
      await expect(sourceSummary).toBeVisible()
      await expect(sourceSummary.getByRole('status')).toHaveText(/^(Available|Partial evidence|Unavailable|Details unavailable)$/, { timeout: 30_000 })
      if (await sourceSummary.getByRole('status').textContent() !== 'Unavailable') {
        await sourceSummary.click()
        await expect(sourceSummary.locator('..').getByText(/^Evidence as of \d{4}-\d{2}-\d{2}T/)).toBeVisible()
        await sourceSummary.click()
      }
    }
    await trustSummary.focus()
    await page.keyboard.press('Enter')
    await expect(trust).not.toHaveAttribute('open', '')

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual((viewport?.width ?? 0) + 1)

    await page.keyboard.press('Tab')
    await expect(page.locator(':focus')).toBeVisible()

    if ((viewport?.width ?? 1440) < 1024) {
      const navButton = page.getByRole('button', { name: /open navigation/i })
      await navButton.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog', { name: /primary navigation/i })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: /primary navigation/i })).toHaveCount(0)
      await expect(navButton).toBeFocused()
    }
  })

  test('keeps ad hierarchy, Creative navigation, and legacy redirects on the selected window', async ({ page }) => {
    const window = 'from=2026-09-02&to=2026-09-04'
    await page.goto(`/performance?${window}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ad investigation', exact: true })).toBeVisible({ timeout: 30_000 })
    const hierarchy = page.getByRole('navigation', { name: 'Reporting hierarchy', exact: true })
    await hierarchy.getByRole('link', { name: 'Ad sets', exact: true }).click()
    await expect(page).toHaveURL(/from=2026-09-02&to=2026-09-04.*level=adset/, { timeout: 15_000 })
    await hierarchy.getByRole('link', { name: 'Ads', exact: true }).click()
    await expect(page).toHaveURL(/from=2026-09-02&to=2026-09-04.*level=ad(?:&|$)/, { timeout: 15_000 })
    await page.getByRole('link', { name: 'Inspect creative', exact: true }).click()
    await expect(page).toHaveURL(/\/creative\?from=2026-09-02&to=2026-09-04/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Creative performance', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('group', { name: 'Creative grouping', exact: true })).toBeVisible()

    await page.goto(`/performance/creative?${window}`, { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/creative\?from=2026-09-02&to=2026-09-04/)
    await expect(page.getByRole('heading', { name: 'Creative performance', exact: true })).toBeVisible({ timeout: 30_000 })

    const viewport = page.viewportSize()
    const dateControl = page.getByTitle('Change the date range (applies across pages)', { exact: true })
    await dateControl.focus()
    await page.keyboard.press('Enter')
    const dateDialog = page.getByRole('dialog', { name: 'Date range', exact: true })
    await expect(dateDialog).toBeVisible()
    await expect(dateDialog.getByRole('group', { name: 'Date range presets' })).toBeVisible()
    await expect(dateDialog.getByLabel('From date', { exact: true })).toHaveValue('2026-09-02')
    await expect(dateDialog.getByLabel('To date', { exact: true })).toHaveValue('2026-09-04')
    const bounds = await dateDialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width)
    await dateDialog.getByLabel('From date', { exact: true }).fill('2026-09-01')
    await page.keyboard.press('Escape')
    await expect(dateDialog).toHaveCount(0)
    await expect(dateControl).toBeFocused()
    await expect(page).toHaveURL(/from=2026-09-01&to=2026-09-04/)
    await page.goBack()
    await expect(page).toHaveURL(/from=2026-09-02&to=2026-09-04/)
  })

  test('uses the single Decisions destination, preserves legacy Inbox links, and supports tab keys', async ({ page }) => {
    await page.goto('/decisions', { waitUntil: 'networkidle' })
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible()
    const viewport = page.viewportSize()
    if ((viewport?.width ?? 1440) < 1024) {
      await page.getByRole('button', { name: /open navigation/i }).click()
      const navigation = page.getByRole('dialog', { name: /primary navigation/i })
      await expect(navigation.getByRole('link', { name: 'Decisions', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(navigation).toHaveCount(0)
    } else {
      await expect(page.getByRole('link', { name: 'Decisions', exact: true })).toBeVisible()
    }

    const firstTab = page.getByRole('tab').first()
    await firstTab.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { selected: true })).toBeFocused()

    await page.goto('/inbox', { waitUntil: 'networkidle' })
    await expect(page).toHaveURL(/\/decisions\?view=tracking_repair&legacy=inbox/)
    await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible()
  })

  test('keeps Activity as the immutable lifecycle route', async ({ page }) => {
    await page.goto('/activity', { waitUntil: 'networkidle' })
    await expect(page).toHaveURL(/\/activity\/change-log/)
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('exposes loading and read-failure states without inventing performance values', async ({ page }) => {
    const sources = ['meta', 'business', 'website', 'measurement']
    const requested = new Set<string>()
    let releaseReports!: () => void
    const pending = new Promise<void>(resolve => { releaseReports = resolve })
    await page.route('**/api/reporting?**', async route => {
      const section = new URL(route.request().url()).searchParams.get('section')!
      expect(route.request().method()).toBe('GET')
      expect(sources).toContain(section)
      requested.add(section)
      await pending
      await route.fulfill({ status: 503, json: { error: 'Controlled reporting source outage.' } })
    })
    try {
      await page.goto('/dashboard?range=mtd', { waitUntil: 'domcontentloaded' })
      await expect(page).not.toHaveURL(/\/login/)
      await expect.poll(() => [...requested].sort()).toEqual([...sources].sort())
      await expect(page.getByText('Loading the selected account and period…', { exact: true })).toBeVisible()
      await expect(page.locator('#reporting-trust > summary')).toContainText('Updating evidence…')
      await expect(page.getByRole('region', { name: 'Business results' })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Advertising results' })).toHaveCount(0)
    } finally { releaseReports() }
    await expect(page.getByText('Reporting could not load. Inspect source details above and retry.', { exact: true })).toBeVisible()
    await expect(page.locator('#reporting-trust > summary')).toContainText('4 sources need attention')
    for (const source of ['Meta advertising', 'Acuity business', 'GA4 website', 'Booking links & tracking']) {
      await expect(page.getByLabel(`${source} source details`, { exact: true }).getByRole('status')).toHaveText('Unavailable')
    }
    await expect(page.getByRole('button', { name: 'Retry reports', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry reports', exact: true })).toBeEnabled()
    await expect(page.getByRole('region', { name: 'Business results' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Advertising results' })).toHaveCount(0)
  })
})
