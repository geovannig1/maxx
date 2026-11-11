'use client'

import { useCallback, useReducer, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { requestRotateWebhookSecret, webhookDialogReducer } from './webhook-secret'
import { WebhookDialogView } from './WebhookSecretDialog'

// Rotate one webhook source's signing secret (owner-only POST /api/outcomes/webhook-sources/<id>/rotate)
// after a confirmation that lets the owner choose how long the old secret keeps working (none for a
// suspected leak). The new secret is shown once, with when the old one stops.

export function WebhookSecretRotate({ id, label }: { id: string; label: string }) {
  const [dialog, dispatch] = useReducer(webhookDialogReducer, { kind: 'closed' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const close = useCallback(() => {
    setError(null)
    dispatch({ type: 'close' })
  }, [])

  async function rotate(graceMinutes: number) {
    setBusy(true)
    setError(null)
    const result = await requestRotateWebhookSecret({ id, label }, graceMinutes)
    setBusy(false)
    // Shown even if the confirmation was dismissed meanwhile: the rotation has already happened.
    if (result.ok) dispatch({ type: 'reveal', reveal: result.reveal })
    else setError(result.message)
  }

  return (
    <>
      <Button ref={buttonRef} type="button" size="sm" variant="outline" aria-label={`Rotate the signing secret of ${label}`}
        onClick={() => dispatch({ type: 'ask-rotate' })}>
        Rotate secret
      </Button>
      <WebhookDialogView state={dialog} label={label} busy={busy} error={error} returnFocus={buttonRef}
        onClose={close} onConfirmRotate={rotate} />
    </>
  )
}
