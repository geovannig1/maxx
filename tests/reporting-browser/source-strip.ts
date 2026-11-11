import type { Locator, Page } from '@playwright/test'

/**
 * On the overview the source strip sits inside the collapsed Trust panel (`details#reporting-trust`),
 * so its rows, details and Refresh buttons are hidden until it opens. Other pages show the strip
 * directly and this is a no-op.
 */
export async function openReportingTrust(page: Page): Promise<void> {
  const trust = page.locator('details#reporting-trust')
  if (await trust.count() && !await trust.evaluate(element => (element as HTMLDetailsElement).open)) await trust.locator('> summary').click()
}

/**
 * One row of the source strip, by its long source name (e.g. 'Meta advertising', 'GA4 website'):
 * every row's summary is labelled `<name> source details`. The overview prints short labels
 * (Meta / Outcomes / GA4 / Tracking), so visible text cannot identify a row. Non-overview pages also
 * label the wrapping section "Reporting source status"; selecting the inner div avoids matching both.
 */
export function sourceRow(page: Page, name: string): Locator {
  return page.locator('div[aria-label="Reporting source status"] > div')
    .filter({ has: page.getByLabel(`${name} source details`, { exact: true }) })
}
