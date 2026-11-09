import { describe, it, expect } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'

// Meta's Ad Library embeds the caller's access token in ad_snapshot_url. The app strips it before
// storing; the database refuses a token-bearing URL as a second line of defence.
const TOKENISED = 'https://www.facebook.com/ads/archive/render_ad/?id=111&access_token=EAA-secret'

async function withSource() {
  const db = await freshSchemaDb()
  const account = await insertAdAccount(db, fixtureUuid(1))
  await db.query(
    `INSERT INTO public.competitor_sources (id, ad_account_id, name) VALUES ($1, $2, 'Example competitor')`,
    [fixtureUuid(2), account],
  )
  return db
}

describe('competitor_ads.ad_snapshot_url never stores an access token', () => {
  it('rejects a snapshot URL that carries an access token', async () => {
    const db = await withSource()
    await expect(db.query(
      `INSERT INTO public.competitor_ads (competitor_id, ad_archive_id, ad_snapshot_url) VALUES ($1, '111', $2)`,
      [fixtureUuid(2), TOKENISED],
    )).rejects.toThrow(/competitor_ads_snapshot_url_no_token/)
    // Also when the parameter is spelled in another case or URL-encoded.
    await expect(db.query(
      `INSERT INTO public.competitor_ads (competitor_id, ad_archive_id, ad_snapshot_url) VALUES ($1, '112', $2)`,
      [fixtureUuid(2), 'https://www.facebook.com/ads/archive/render_ad/?id=112&Access%5FToken=x'],
    )).rejects.toThrow(/competitor_ads_snapshot_url_no_token/)
  })

  it('accepts a redacted snapshot URL and a null one (control)', async () => {
    const db = await withSource()
    await db.query(
      `INSERT INTO public.competitor_ads (competitor_id, ad_archive_id, ad_snapshot_url)
       VALUES ($1, '113', 'https://www.facebook.com/ads/archive/render_ad/?id=113'), ($1, '114', NULL)`,
      [fixtureUuid(2)],
    )
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.competitor_ads`)
    expect(rows[0].n).toBe(2)
  })
})

// Security review: the CHECK is an allowlist of what redactSnapshotUrl emits. The application tests read
// the same pattern from the shipped schema (tests/fixtures/snapshot-url-allowlist.ts).
const BYPASSES = [
  'https://www.facebook.com/ads/archive/render_ad/?id=1&%61ccess_token=x',
  'https://www.facebook.com/ads/archive/render_ad/?id=1&access-token=x',
  'https://www.facebook.com/ads/archive/render_ad/?id=1&accessToken=x',
  'https://www.facebook.com/ads/archive/render_ad/?id=1&access%255Ftoken=x',
  'https://www.facebook.com/ads/archive/render_ad/?id=1&oauth_token=x',
  'https://www.facebook.com/ads/archive/render_ad/?id=1#access_token=x',
  'https://www.facebook.com/ads/archive/render_ad/?id=12abc',
  'https://facebook.com.evil.test/ads/archive/render_ad/?id=1',
  'http://www.facebook.com/ads/archive/render_ad/?id=1',
]

describe('competitor_ads.ad_snapshot_url allowlist', () => {
  it('rejects every previous blacklist bypass', async () => {
    const db = await withSource()
    for (const [index, url] of BYPASSES.entries()) {
      await expect(db.query(
        `INSERT INTO public.competitor_ads (competitor_id, ad_archive_id, ad_snapshot_url) VALUES ($1, $2, $3)`,
        [fixtureUuid(2), String(200 + index), url],
      ), url).rejects.toThrow(/competitor_ads_snapshot_url_no_token/)
    }
  })

  it('accepts what redactSnapshotUrl emits for those inputs (the fetcher batch cannot abort)', async () => {
    const { redactSnapshotUrl } = await import('@/lib/competitors/snapshot-url')
    const db = await withSource()
    const inputs = [...BYPASSES, TOKENISED, 'https://facebook.com/ads/archive/render_ad/?id=9']
    const outputs = inputs.map((input) => redactSnapshotUrl(input))
    // Control: most of these redact to a stored URL rather than to null.
    expect(outputs.filter((output) => output !== null).length).toBeGreaterThanOrEqual(7)
    for (const [index, output] of outputs.entries()) {
      await db.query(
        `INSERT INTO public.competitor_ads (competitor_id, ad_archive_id, ad_snapshot_url) VALUES ($1, $2, $3)`,
        [fixtureUuid(2), String(300 + index), output],
      )
    }
  })

  it('the CHECK and the application tests read one allowlist from the shipped schema', async () => {
    const { snapshotUrlAllowlist } = await import('../fixtures/snapshot-url-allowlist')
    const db = await withSource()
    const { rows } = await db.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'public.competitor_ads'::regclass AND conname = 'competitor_ads_snapshot_url_no_token'`)
    expect(rows).toHaveLength(1)
    // The literal the live database enforces equals the one the application tests use.
    expect(snapshotUrlAllowlist(rows[0].d).source).toBe(snapshotUrlAllowlist().source)
    // Controls: the fixture refuses an unanchored literal and a second, different one.
    expect(() => snapshotUrlAllowlist("CHECK (ad_snapshot_url ~ 'facebook')")).toThrow(/anchored/)
    expect(() => snapshotUrlAllowlist("ad_snapshot_url ~ '^a$' ad_snapshot_url ~ '^b$'")).toThrow(/expected one/)
  })
})
