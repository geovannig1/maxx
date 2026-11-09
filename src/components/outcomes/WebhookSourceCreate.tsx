'use client'

import { useCallback, useReducer, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { requestCreateWebhookSource, webhookDialogReducer } from './webhook-secret'
import { WebhookDialogView } from './WebhookSecretDialog'

// Create a signed-webhook source (owner-only POST /api/outcomes/webhook-sources). A new source is off
// unless the owner ticks the box. The secret is shown once in a dialog; closing it discards the secret
// and refreshes the list so the new source appears.

export function WebhookSourceCreate() {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialog, dispatch] = useReducer(webhookDialogReducer, { kind: 'closed' })
  const nameRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await requestCreateWebhookSource({ label, enabled })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setLabel('')
    setEnabled(false)
    dispatch({ type: 'reveal', reveal: result.reveal })
  }

  const close = useCallback(() => {
    dispatch({ type: 'close' })
    router.refresh()
  }, [router])

  // The dialog sits outside the form: Enter in its secret field must never submit another create.
  return (
    <>
    <form onSubmit={submit} className="space-y-3" aria-describedby={error ? 'webhook-create-error' : undefined}>
      <div className="space-y-1">
        <label htmlFor="webhook-source-label" className="text-sm font-medium">Name</label>
        <Input ref={nameRef} id="webhook-source-label" required maxLength={128} value={label} autoComplete="off"
          onChange={(event) => setLabel(event.target.value)} aria-invalid={error ? true : undefined} />
      </div>
      <div className="flex items-center gap-2 text-sm">
        <input id="webhook-source-enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <label htmlFor="webhook-source-enabled">Turn on now (otherwise it stays off until you enable it below)</label>
      </div>
      <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create webhook source'}</Button>
      {error ? <p id="webhook-create-error" role="alert" className="owner-notice owner-warning">{error}</p> : null}
    </form>
    <WebhookDialogView state={dialog} label={label} busy={false} error={null} returnFocus={nameRef}
      onClose={close} onConfirmRotate={() => undefined} />
    </>
  )
}
