'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import {
  WEBHOOK_SIGNATURE_FORMAT,
  WEBHOOK_SIGNATURE_HEADER,
  type SecretReveal,
  type WebhookDialogState,
} from './webhook-secret'

// The modal dialogs of webhook source management. A native <dialog> opened with showModal() makes the
// rest of the page inert, keeps Tab inside, closes on Escape (routed through onClose so React state
// decides) and is labelled and described by its title and warning. Focus returns to the element that
// opened it. A closed dialog is not rendered at all, so its secret leaves the DOM with it.

function ModalDialog(props: {
  titleId: string
  descriptionId: string
  role?: 'alertdialog'
  /** Where focus goes on close; defaults to the element focused when the dialog opened. */
  returnFocus?: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // The latest onClose, read at Escape time: the dialog opens once and is never re-opened by a re-render.
  const onCloseRef = useRef(props.onClose)
  const returnFocusRef = useRef(props.returnFocus)
  useEffect(() => {
    onCloseRef.current = props.onClose
    returnFocusRef.current = props.returnFocus
  })
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const onCancel = (event: Event) => {
      event.preventDefault()
      onCloseRef.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open) dialog.close()
      const target = returnFocusRef.current?.current ?? opener
      if (target?.isConnected) target.focus()
    }
  }, [])
  return (
    <dialog ref={ref} role={props.role} aria-modal="true" aria-labelledby={props.titleId} aria-describedby={props.descriptionId}
      className="m-auto w-full max-w-lg space-y-4 rounded-lg border p-6 text-sm backdrop:bg-black/40"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated, var(--background))', color: 'inherit' }}>
      {props.children}
    </dialog>
  )
}

function SecretRevealDialog({ reveal, onClose, returnFocus }: {
  reveal: SecretReveal
  onClose: () => void
  returnFocus?: RefObject<HTMLElement | null>
}) {
  const [copyStatus, setCopyStatus] = useState('')
  // The full URL needs the browser's origin; this dialog only opens after a request in the browser.
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin))

  async function copy() {
    try {
      await navigator.clipboard.writeText(reveal.secret)
      setCopyStatus('Copied.')
    } catch {
      setCopyStatus('Copy failed: select the secret and copy it.')
    }
  }

  return (
    <ModalDialog titleId="webhook-secret-title" descriptionId="webhook-secret-warning" onClose={onClose} returnFocus={returnFocus}>
      <h2 id="webhook-secret-title" className="text-base font-semibold">
        {reveal.action === 'created' ? 'Webhook source created' : 'Secret rotated'}: {reveal.label}
      </h2>
      <p id="webhook-secret-warning" className="owner-notice owner-warning">
        Copy this signing secret now and store it in your sending system. You won&apos;t see this secret again: closing this dialog discards it, and only rotating gives a new one.
      </p>
      <div className="space-y-1">
        <label htmlFor="webhook-secret-value" className="font-medium">Signing secret</label>
        <div className="flex gap-2">
          <input id="webhook-secret-value" readOnly value={reveal.secret} spellCheck={false} autoComplete="off"
            onFocus={(event) => event.currentTarget.select()}
            className="h-8 w-full min-w-0 rounded-lg border px-2.5 font-mono text-xs" style={{ borderColor: 'var(--border)' }} />
          <Button type="button" variant="outline" onClick={copy} autoFocus>Copy secret</Button>
        </div>
        <p role="status" aria-live="polite" className="text-xs">{copyStatus}</p>
      </div>
      <dl className="space-y-2">
        <div>
          <dt className="font-medium">Endpoint</dt>
          <dd><code className="break-all">POST {origin}{reveal.path}</code></dd>
        </div>
        <div>
          <dt className="font-medium">Signature header</dt>
          <dd><code className="break-all">{WEBHOOK_SIGNATURE_HEADER}: {WEBHOOK_SIGNATURE_FORMAT}</code></dd>
        </div>
      </dl>
      <div className="flex justify-end">
        <Button type="button" onClick={onClose}>Done</Button>
      </div>
    </ModalDialog>
  )
}

function ConfirmRotateDialog(props: {
  label: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  returnFocus?: RefObject<HTMLElement | null>
}) {
  return (
    <ModalDialog role="alertdialog" titleId="webhook-rotate-title" descriptionId="webhook-rotate-warning"
      onClose={props.onCancel} returnFocus={props.returnFocus}>
      <h2 id="webhook-rotate-title" className="text-base font-semibold">Rotate the signing secret of {props.label}?</h2>
      <p id="webhook-rotate-warning">
        The old secret stops working immediately: deliveries signed with it are refused until your sender uses the new secret. There is no grace period.
      </p>
      {props.error ? <p role="alert" className="owner-notice owner-warning">{props.error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy} autoFocus>Cancel</Button>
        <Button type="button" variant="destructive" onClick={props.onConfirm} disabled={props.busy}>
          {props.busy ? 'Rotating…' : 'Rotate secret'}
        </Button>
      </div>
    </ModalDialog>
  )
}

/** The dialog for the current state: nothing when closed. */
export function WebhookDialogView(props: {
  state: WebhookDialogState
  label: string
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirmRotate: () => void
  returnFocus?: RefObject<HTMLElement | null>
}) {
  if (props.state.kind === 'revealed') {
    return <SecretRevealDialog reveal={props.state.reveal} onClose={props.onClose} returnFocus={props.returnFocus} />
  }
  if (props.state.kind === 'confirm-rotate') {
    return <ConfirmRotateDialog label={props.label} busy={props.busy} error={props.error}
      onConfirm={props.onConfirmRotate} onCancel={props.onClose} returnFocus={props.returnFocus} />
  }
  return null
}
