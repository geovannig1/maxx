'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  getMagicLinkSendGuard,
  MAGIC_LINK_SEND_GUARD_STORAGE_KEY,
  recordMagicLinkRateLimit,
  recordMagicLinkRequest,
  type MagicLinkSendGuard,
} from '@/lib/auth/magic-link-send-guard'
import { toast } from 'sonner'

// A redirect back to /login can carry an ?error= code (magic-link failure, or the owner gate in
// proxy.ts / auth callback). Map each to a plain-English reason so the user isn't handed a blank form.
const AUTH_ERRORS: Record<string, string> = {
  auth: 'That sign-in link needs to be opened in the same browser and profile where it was requested. Request a new one only if needed.',
  unauthorized: 'That email isn’t authorized for this tool.',
  owner_unconfigured: 'Access isn’t set up yet: OWNER_EMAIL is not configured. Open /setup for the checklist.',
}

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard'
}

const INITIAL_SEND_GUARD: MagicLinkSendGuard = { canRequest: false, retryAt: null }

function readStoredMagicLinkRequests(): number[] {
  try {
    const stored = window.localStorage.getItem(MAGIC_LINK_SEND_GUARD_STORAGE_KEY)
    const parsed: unknown = stored ? JSON.parse(stored) : []
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'number') ? parsed : []
  } catch {
    return []
  }
}

function writeStoredMagicLinkRequests(requests: number[]) {
  try {
    window.localStorage.setItem(MAGIC_LINK_SEND_GUARD_STORAGE_KEY, JSON.stringify(requests))
  } catch {
    // Storage can be unavailable in privacy modes. Supabase's server-side limit still applies.
  }
}

function retryMessage(retryAt: number | null): string {
  if (!retryAt) return ''
  const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000))
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function isEmailRateLimit(message: string): boolean {
  return /email.*rate limit|rate limit.*email|over_email_send_rate_limit/i.test(message)
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [emailFocused, setEmailFocused] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [sendGuard, setSendGuard] = useState<MagicLinkSendGuard>(INITIAL_SEND_GUARD)
  const [sendGuardReady, setSendGuardReady] = useState(false)

  useEffect(() => {
    // One-shot, client-only read of the redirect's ?error= after mount, so the error banner doesn't
    // cause an SSR/hydration mismatch (the query isn't known at server-render time). The setState here is
    // intentional and runs once — this specific case is what the generic rule can't distinguish.
    const err = new URLSearchParams(window.location.search).get('error')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (err) setAuthError(AUTH_ERRORS[err] ?? 'Sign-in failed — please request a new link.')
  }, [])

  useEffect(() => {
    const refreshSendGuard = () => {
      setSendGuard(getMagicLinkSendGuard(readStoredMagicLinkRequests(), Date.now()))
      setSendGuardReady(true)
    }

    refreshSendGuard()
    const interval = window.setInterval(refreshSendGuard, 1_000)
    return () => window.clearInterval(interval)
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return

    const now = Date.now()
    const currentGuard = getMagicLinkSendGuard(readStoredMagicLinkRequests(), now)
    if (!currentGuard.canRequest) {
      setSendGuard(currentGuard)
      return
    }

    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext(new URLSearchParams(window.location.search).get('next')))}`,
          // Single-owner tool: never provision a new account from a magic link. Combined with the
          // API owner gate, this closes the "any email that completes the OTP becomes a user" path.
          shouldCreateUser: false,
        },
      })

      if (error) {
        if (isEmailRateLimit(error.message)) {
          const limitedRequests = recordMagicLinkRateLimit(now)
          writeStoredMagicLinkRequests(limitedRequests)
          setSendGuard(getMagicLinkSendGuard(limitedRequests, now))
          setAuthError('Email sending is temporarily limited. Please wait up to one hour before requesting one new link.')
          toast.error('Email sending is temporarily limited.')
        } else {
          toast.error(error.message)
        }
      } else {
        const requests = recordMagicLinkRequest(readStoredMagicLinkRequests(), now)
        writeStoredMagicLinkRequests(requests)
        setSendGuard(getMagicLinkSendGuard(requests, now))
        setSent(true)
        toast.success('Magic link sent — check your inbox.')
      }
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    // <main> because this page had no landmarks at all — assistive technology got no
    // structure on the one screen every session starts with.
    <main
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="w-full max-w-sm card-base p-8">
        {/* Maxx logo */}
        <div className="flex items-center gap-3 mb-8">
          <div
            className="w-9 h-9 rounded-[8px] flex items-center justify-center shrink-0"
            style={{
              background: 'var(--accent)',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path d="M9 2L4 9h5l-2 5 6-8H8l1-4z" fill="white" />
            </svg>
          </div>
          <span
            style={{
              fontSize: '18px',
              fontWeight: 700,
              color: 'var(--text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            Maxx
          </span>
        </div>

        {/* Heading */}
        <h1
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
            marginBottom: '6px',
          }}
        >
          Sign in to Maxx
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            marginBottom: '24px',
          }}
        >
          We&rsquo;ll send a magic link to your email.
        </p>

        {authError && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 'var(--r-md)',
              background: 'var(--danger-bg, #FEF2F2)',
              border: '1px solid var(--danger-border, #FECACA)',
              marginBottom: '16px',
            }}
          >
            <p style={{ fontSize: '12.5px', color: 'var(--danger, #DC2626)', lineHeight: 1.45 }}>{authError}</p>
          </div>
        )}

        {sent ? (
          <div className="text-center py-4 space-y-2">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center mx-auto"
              style={{ background: 'var(--success-bg)' }}
            >
              <svg
                className="w-5 h-5"
                style={{ color: 'var(--success)' }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p
              className="text-sm font-medium"
              style={{ color: 'var(--text-primary)' }}
            >
              Check your inbox
            </p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              We sent a magic link to{' '}
              <span style={{ color: 'var(--text-secondary)' }}>{email}</span>
            </p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Open the newest link in this same browser and profile.
              {!sendGuard.canRequest && ` Another request is available in ${retryMessage(sendGuard.retryAt)}.`}
            </p>
            <button
              onClick={() => setSent(false)}
              className="text-xs mt-2"
              style={{ color: 'var(--accent-hover)' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.color = 'var(--accent)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.color = 'var(--accent-hover)')
              }
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="email"
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '13px',
                  fontWeight: 500,
                  display: 'block',
                }}
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example-studio.test"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                onFocus={() => setEmailFocused(true)}
                onBlur={() => setEmailFocused(false)}
                style={{
                  background: 'var(--bg-input)',
                  border: `1px solid ${emailFocused ? 'var(--accent)' : 'var(--border)'}`,
                  boxShadow: emailFocused ? '0 0 0 3px var(--accent-dim)' : 'none',
                  color: 'var(--text-primary)',
                  borderRadius: 'var(--r-md)',
                  // 44px clears the WCAG/Apple minimum target; 16px is the threshold below
                  // which iOS Safari auto-zooms the viewport on focus. Both were missed
                  // because this page is only ever tested on a desktop.
                  height: '44px',
                  padding: '0 12px',
                  width: '100%',
                  fontSize: '16px',
                  // No `outline: none` — the 8% accent-dim ring alone is effectively
                  // invisible. Dropping the override lets the :focus-visible rule in
                  // @layer base draw a real 2px outline for keyboard users.
                  transition: 'border-color 100ms, box-shadow 100ms',
                }}
              />
            </div>

            {!sendGuard.canRequest && sendGuardReady && (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)', lineHeight: 1.45 }}>
                To avoid email-provider limits, another link can be requested in {retryMessage(sendGuard.retryAt)}.
              </p>
            )}

            <SubmitButton
              loading={loading}
              disabled={loading || !email.trim() || !sendGuardReady || !sendGuard.canRequest}
              label={!sendGuardReady || !sendGuard.canRequest ? 'Magic link temporarily unavailable' : 'Send Magic Link'}
            />
          </form>
        )}

        <p
          className="text-center text-xs mt-6"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Private tool — authorized personnel only
        </p>
      </div>
    </main>
  )
}

function SubmitButton({
  loading,
  disabled,
  label,
}: {
  loading: boolean
  disabled: boolean
  label: string
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="submit"
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered && !disabled ? 'var(--accent-hover)' : 'var(--accent)',
        color: 'var(--on-accent)',
        width: '100%',
        // Matches the email field: 44px minimum touch target.
        height: '44px',
        borderRadius: 'var(--r-md)',
        fontSize: '14px',
        fontWeight: 500,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 100ms',
      }}
    >
      {loading ? 'Sending…' : label}
    </button>
  )
}
