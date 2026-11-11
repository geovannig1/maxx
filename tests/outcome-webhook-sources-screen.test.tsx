import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import {
  WEBHOOK_SIGNATURE_FORMAT,
  WEBHOOK_SIGNATURE_HEADER,
  requestCreateWebhookSource,
  requestRotateWebhookSecret,
  webhookDialogReducer,
  type WebhookDialogState,
} from '@/components/outcomes/webhook-secret'
import { WebhookDialogView } from '@/components/outcomes/WebhookSecretDialog'
import { WebhookSourceCreate } from '@/components/outcomes/WebhookSourceCreate'
import { WebhookSecretRotate } from '@/components/outcomes/WebhookSecretRotate'
import { SIGNATURE_HEADER } from '@/lib/outcomes/adapters/webhook/signature'

// webhook sources are created and rotated on /settings/outcomes. The signing secret is shown
// once, in a modal dialog, and lives only in that dialog's state: closing it discards the secret.
// The suite has no DOM, so behaviour is pinned through the pure state machine and request helpers,
// and markup through server rendering of each state.

const SOURCE_ID = '0f8e3c1a-2b4d-4e6f-8a9b-0c1d2e3f4a5b'
const SECRET = '3c'.repeat(32)
const reveal = { sourceId: SOURCE_ID, label: 'Online shop', secret: SECRET, path: `/api/outcomes/webhook/${SOURCE_ID}`, action: 'created' as const }
const view = (state: WebhookDialogState, extra: Partial<React.ComponentProps<typeof WebhookDialogView>> = {}) =>
  renderToStaticMarkup(<WebhookDialogView state={state} label="Online shop" busy={false} error={null}
    onClose={() => undefined} onConfirmRotate={() => undefined} {...extra} />)

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('webhook secret dialog state', () => {
  it('holds the secret only while revealed; closing discards it', () => {
    const open = webhookDialogReducer({ kind: 'closed' }, { type: 'reveal', reveal })
    expect(JSON.stringify(open)).toContain(SECRET)
    const closed = webhookDialogReducer(open, { type: 'close' })
    expect(closed).toEqual({ kind: 'closed' })
    expect(JSON.stringify(closed)).not.toContain(SECRET)
  })

  it('asks before rotating and never carries a secret while asking', () => {
    const asking = webhookDialogReducer({ kind: 'closed' }, { type: 'ask-rotate' })
    expect(asking).toEqual({ kind: 'confirm-rotate' })
    expect(webhookDialogReducer(asking, { type: 'close' })).toEqual({ kind: 'closed' })
  })

  it('renders the secret while revealed and nothing at all after the dialog closes', () => {
    const open = webhookDialogReducer({ kind: 'closed' }, { type: 'reveal', reveal })
    expect(view(open)).toContain(SECRET)
    const html = view(webhookDialogReducer(open, { type: 'close' }))
    expect(html).toBe('')
    expect(html).not.toContain(SECRET)
  })
})

describe('secret dialog markup', () => {
  it('is a labelled modal dialog with the secret, a copy button and the one-time warning', () => {
    const html = view({ kind: 'revealed', reveal })
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="webhook-secret-title"/)
    expect(html).toMatch(/<dialog[^>]*aria-describedby="webhook-secret-warning"/)
    expect(html).toContain('id="webhook-secret-title"')
    expect(html).toMatch(/id="webhook-secret-warning"[^>]*>[^<]*won(&#x27;|')t see this secret again/i)
    expect(html).toMatch(/<label[^>]*for="webhook-secret-value"/)
    expect(html).toMatch(/<input[^>]*id="webhook-secret-value"[^>]*readOnly=""|<input[^>]*readOnly=""[^>]*id="webhook-secret-value"/)
    expect(html).toContain(`value="${SECRET}"`)
    expect(html).toMatch(/<button[^>]*>Copy secret<\/button>/)
    expect(html).toMatch(/role="status"/)
    expect(html).toMatch(/<button[^>]*>Done<\/button>/)
  })

  it('shows where to send and how to sign: the endpoint and the signature header format', () => {
    const html = view({ kind: 'revealed', reveal })
    expect(html).toContain(`/api/outcomes/webhook/${SOURCE_ID}`)
    expect(html).toContain(WEBHOOK_SIGNATURE_HEADER)
    const escaped = WEBHOOK_SIGNATURE_FORMAT.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    expect(html).toContain(escaped)
  })

  it('the documented header name is the one the verifier reads', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe(SIGNATURE_HEADER)
    expect(WEBHOOK_SIGNATURE_FORMAT).toMatch(/^t=<unix seconds>,v1=<hex HMAC-SHA256\(secret, t \+ "\." \+ raw body\)>$/)
  })

  it('asks for confirmation before rotating, explains the grace window, and focuses Cancel first', () => {
    const html = view({ kind: 'confirm-rotate' })
    expect(html).toMatch(/<dialog[^>]*role="alertdialog"/)
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="webhook-rotate-title"/)
    expect(html).toMatch(/<dialog[^>]*aria-describedby="webhook-rotate-warning"/)
    expect(html).toMatch(/id="webhook-rotate-warning"[^>]*>[^<]*old secret keeps working for the time you choose/i)
    expect(html).toMatch(/[Cc]hoose (&quot;|")Immediately(&quot;|") if the secret may have leaked/)
    // A labelled choice of window, defaulting to one hour; "Immediately" stops the old secret at once.
    expect(html).toMatch(/<label[^>]*for="webhook-rotate-grace"/)
    expect(html).toMatch(/<select[^>]*id="webhook-rotate-grace"/)
    expect(html).toMatch(/<option value="0"[^>]*>Immediately<\/option>/)
    expect(html).toMatch(/<option value="60" selected=""[^>]*>1 hour<\/option>/)
    expect(html).toMatch(/<option value="1440"[^>]*>24 hours<\/option>/)
    expect(html).toContain('Online shop')
    // Cancel comes first, so the dialog's initial focus is the safe choice.
    expect(html.indexOf('>Cancel<')).toBeGreaterThan(-1)
    expect(html.indexOf('>Cancel<')).toBeLessThan(html.indexOf('>Rotate secret<'))
    expect(html).not.toContain(SECRET)
  })

  it('shows a rotation failure as an alert and disables the buttons while busy', () => {
    const html = view({ kind: 'confirm-rotate' }, { busy: true, error: 'The secret was not rotated.' })
    expect(html).toMatch(/role="alert"[^>]*>The secret was not rotated\./)
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

describe('create form and rotate button', () => {
  it('labels the name field, leaves the new source off by default and renders no secret', () => {
    const html = renderToStaticMarkup(<WebhookSourceCreate />)
    expect(html).toMatch(/<label[^>]*for="webhook-source-label"/)
    expect(html).toMatch(/<input[^>]*id="webhook-source-label"[^>]*required=""|<input[^>]*required=""[^>]*id="webhook-source-label"/)
    expect(html).toMatch(/maxLength="128"/)
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*id="webhook-source-enabled"|<input[^>]*id="webhook-source-enabled"[^>]*type="checkbox"/)
    expect(html).not.toMatch(/id="webhook-source-enabled"[^>]*checked=""/)
    expect(html).toMatch(/<label[^>]*for="webhook-source-enabled"/)
    expect(html).not.toContain('<dialog')
  })

  it('names the rotate button after its source and renders no dialog until asked', () => {
    const html = renderToStaticMarkup(<WebhookSecretRotate id={SOURCE_ID} label="Online shop" />)
    expect(html).toMatch(/<button[^>]*aria-label="Rotate the signing secret of Online shop"/)
    expect(html).not.toContain('<dialog')
  })
})

describe('owner-only route requests', () => {
  it('creates a source with the label and the off-by-default flag, and reads the one-time secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {
      source_id: SOURCE_ID, secret: SECRET, enabled: false, signature_header: 'x-maxx-signature', path: `/api/outcomes/webhook/${SOURCE_ID}`,
    }))
    const result = await requestCreateWebhookSource({ label: '  Online shop ', enabled: false }, fetchImpl)
    expect(result).toEqual({ ok: true, reveal: { ...reveal, action: 'created' } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/outcomes/webhook-sources')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ label: 'Online shop', enabled: false })
    expect(init.cache).toBe('no-store')
  })

  it('rotates by id with the chosen grace window and reads the new secret and when the old one stops', async () => {
    const until = '2026-11-10T19:00:00.000Z'
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { source_id: SOURCE_ID, secret: SECRET, previous_secret_valid_until: until }))
    const result = await requestRotateWebhookSecret({ id: SOURCE_ID, label: 'Online shop' }, 60, fetchImpl)
    expect(result).toEqual({ ok: true, reveal: { ...reveal, action: 'rotated', previousSecretValidUntil: until } })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/outcomes/webhook-sources/${SOURCE_ID}/rotate`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ grace_minutes: 60 })

    // Immediately: the route says the old secret has already stopped; an unusable instant reads the same way.
    for (const value of [null, 'not-a-date']) {
      const stopped = await requestRotateWebhookSecret({ id: SOURCE_ID, label: 'Online shop' }, 0,
        vi.fn().mockResolvedValue(jsonResponse(200, { source_id: SOURCE_ID, secret: SECRET, previous_secret_valid_until: value })))
      expect(stopped).toEqual({ ok: true, reveal: { ...reveal, action: 'rotated', previousSecretValidUntil: null } })
    }
  })

  it('the rotated secret dialog says until when the old secret keeps working, or that it has stopped', () => {
    const open = view({ kind: 'revealed', reveal: { ...reveal, action: 'rotated', previousSecretValidUntil: '2026-11-10T19:00:00.000Z' } })
    expect(open).toMatch(/old secret keeps working until 2026-11-10 19:00 UTC/i)
    const stopped = view({ kind: 'revealed', reveal: { ...reveal, action: 'rotated', previousSecretValidUntil: null } })
    expect(stopped).toMatch(/old secret has stopped working/i)
    expect(view({ kind: 'revealed', reveal })).not.toMatch(/old secret/i)
  })

  it('controls: a refusal, a malformed body or a network failure is a plain message, never a reveal', async () => {
    const cases: Array<[() => Promise<Response>, RegExp]> = [
      [async () => jsonResponse(403, { error: 'Forbidden' }), /Forbidden/],
      [async () => jsonResponse(201, { source_id: SOURCE_ID, secret: 'short' }), /not created/],
      [async () => jsonResponse(201, { source_id: 'not-a-uuid', secret: SECRET }), /not created/],
      [async () => new Response('<html>', { status: 500 }), /not created/],
      [async () => { throw new TypeError('offline') }, /not created/],
    ]
    for (const [respond, message] of cases) {
      const result = await requestCreateWebhookSource({ label: 'Shop', enabled: false }, vi.fn(respond))
      expect(result.ok).toBe(false)
      expect(!result.ok && result.message).toMatch(message)
      expect(JSON.stringify(result)).not.toContain(SECRET)
    }
    const rotated = await requestRotateWebhookSecret({ id: SOURCE_ID, label: 'Shop' }, 60, vi.fn(async () => jsonResponse(404, { error: 'Not found', code: 'NOT_FOUND' })))
    expect(rotated).toEqual({ ok: false, message: 'Not found' })
  })

  it('refuses an empty name without calling the route', async () => {
    const fetchImpl = vi.fn()
    expect(await requestCreateWebhookSource({ label: '   ', enabled: true }, fetchImpl)).toEqual({ ok: false, message: 'Enter a name for the source.' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

const page = vi.hoisted(() => ({ sources: [] as Array<Record<string, unknown>>, grace: {} as Record<string, string> | Error }))
vi.mock('@/lib/outcomes/adapters/webhook/sources', async (original) => ({
  ...await original<typeof import('@/lib/outcomes/adapters/webhook/sources')>(),
  readWebhookSecretGrace: async () => { if (page.grace instanceof Error) throw page.grace; return page.grace },
}))
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => undefined }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))
vi.mock('@/lib/accounts/active-account', () => ({ resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1' } }) }))
vi.mock('@/lib/outcomes/source-admin', async (original) => ({
  ...await original<typeof import('@/lib/outcomes/source-admin')>(),
  listOutcomeSources: async () => page.sources,
}))

describe('outcome sources page', () => {
  it('offers webhook creation and a rotate button and endpoint for webhook sources only', async () => {
    page.sources = [
      { id: SOURCE_ID, kind: 'webhook', label: 'Online shop', enabled: false, created_at: '2026-11-01T00:00:00Z', last_success_at: null },
      { id: '1f8e3c1a-2b4d-4e6f-8a9b-0c1d2e3f4a5b', kind: 'csv', label: 'Imports', enabled: true, created_at: '2026-11-01T00:00:00Z', last_success_at: null },
    ]
    const { default: OutcomeSourcesPage } = await import('@/app/(dashboard)/settings/outcomes/page')
    const html = renderToStaticMarkup(await OutcomeSourcesPage())
    expect(html).toContain('id="webhook-create-title"')
    expect(html).toMatch(/<label[^>]*for="webhook-source-label"/)
    expect(html).toContain(`POST /api/outcomes/webhook/${SOURCE_ID}`)
    expect(html.match(/aria-label="Rotate the signing secret of [^"]*"/g)).toEqual(['aria-label="Rotate the signing secret of Online shop"'])
    expect(html).not.toContain('/api/outcomes/webhook/1f8e3c1a')
    expect(html).not.toContain('<dialog')
    // The old console instructions are gone from the screen.
    expect(html).not.toContain('/api/outcomes/webhook-sources')
    expect(html).not.toMatch(/old secret/i)
  })

  it('shows until when a rotated source still accepts its old secret, and stays up when that cannot be read', async () => {
    page.sources = [
      { id: SOURCE_ID, kind: 'webhook', label: 'Online shop', enabled: true, created_at: '2026-11-01T00:00:00Z', last_success_at: null },
    ]
    page.grace = { [SOURCE_ID]: '2026-11-10T19:00:00.000Z' }
    const { default: OutcomeSourcesPage } = await import('@/app/(dashboard)/settings/outcomes/page')
    const html = renderToStaticMarkup(await OutcomeSourcesPage())
    expect(html).toMatch(/Old secret still accepted until 2026-11-10 19:00 UTC/)
    expect(html).not.toMatch(/[0-9a-f]{64}/)

    page.grace = new Error('database unavailable')
    const degraded = renderToStaticMarkup(await OutcomeSourcesPage())
    expect(degraded).toContain(`POST /api/outcomes/webhook/${SOURCE_ID}`)
    expect(degraded).not.toMatch(/Old secret still accepted/)
    page.grace = {}
  })
})
