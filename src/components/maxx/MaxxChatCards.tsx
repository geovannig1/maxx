import Link from 'next/link'
import { ClipboardCheck, FileText, PenLine, ShieldAlert } from 'lucide-react'
import type { ChatCard } from '@/lib/maxx/chat-cards'

// ADR-062: the card under an Ask Maxx action turn. It shows what Maxx produced and links to where the
// owner reviews it. A card has no approve or apply control: approval stays on the Changes page.

const box: React.CSSProperties = { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '11px 14px', marginTop: 8 }
const title: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 8px' }
const link: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', minHeight: 44, fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }
const STATUS_COLOR: Record<string, string> = { ok: 'var(--success)', warn: 'var(--warning)', blocked: 'var(--danger)', unknown: 'var(--text-tertiary)' }

function CopyCard({ card }: { card: Extract<ChatCard, { kind: 'copy' }> }) {
  return (
    <section data-chat-card="copy" style={box} aria-label="Copy variants">
      <p style={title}><PenLine className="w-3.5 h-3.5" aria-hidden /> Copy variants</p>
      <ol style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 18, margin: 0 }}>
        {card.variants.map((v, i) => (
          <li key={i} style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            <p style={{ margin: 0, color: 'var(--text-primary)' }}>{v.primary_text}</p>
            <p style={{ margin: '2px 0 0' }}><b>{v.headline}</b>{v.description ? ` · ${v.description}` : ''} · {v.cta.replace(/_/g, ' ').toLowerCase()}</p>
            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: v.status === 'ready' ? 'var(--success)' : 'var(--warning)' }}>
              Score {v.score}/100 · {v.status === 'ready' ? 'ready to use' : 'review the notes'}{v.angle ? ` · ${v.angle.replace(/_/g, ' ')}` : ''}
            </p>
            {v.warnings.length > 0 && <ul style={{ margin: '2px 0 0', paddingLeft: 16, fontSize: 11.5 }}>{v.warnings.map((w, j) => <li key={j}>{w}</li>)}</ul>}
          </li>
        ))}
      </ol>
      {card.withheld > 0 && <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '8px 0 0' }}>{card.withheld} variant withheld by the copy scorer (unverified claim or policy risk).</p>}
      <Link href={card.href} style={link}>Save or edit in the Copy studio</Link>
    </section>
  )
}

function PlanCard({ card }: { card: Extract<ChatCard, { kind: 'plan' }> }) {
  return (
    <section data-chat-card="plan" style={box} aria-label="Campaign plan draft">
      <p style={title}><FileText className="w-3.5 h-3.5" aria-hidden /> Campaign plan draft{card.source === 'template' ? ' (template planner)' : ''}</p>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-primary)' }}>{card.name}</p>
      <p style={{ margin: '2px 0 6px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {card.objective.replace('OUTCOME_', '').toLowerCase()} · {card.daily_budget}/day · {card.ad_sets} ad set{card.ad_sets === 1 ? '' : 's'} · {card.ads} ad{card.ads === 1 ? '' : 's'} · everything starts paused
      </p>
      <p style={{ margin: '0 0 6px', fontSize: 12, color: card.blockers ? 'var(--danger)' : 'var(--text-tertiary)' }}>
        {card.blockers} blocker{card.blockers === 1 ? '' : 's'} · {card.warnings} warning{card.warnings === 1 ? '' : 's'}
      </p>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {card.readiness.map((r) => (
          <li key={r.label} style={{ fontSize: 11, border: `1px solid ${STATUS_COLOR[r.status] ?? 'var(--border)'}`, color: STATUS_COLOR[r.status] ?? 'var(--text-tertiary)', borderRadius: 999, padding: '2px 8px' }}>{r.label}: {r.status}</li>
        ))}
      </ul>
      {card.notes.map((n, i) => <p key={i} style={{ fontSize: 11.5, color: 'var(--text-tertiary)', margin: '6px 0 0' }}>{n}</p>)}
      <Link href={card.href} style={link}>Review, edit and submit the plan</Link>
    </section>
  )
}

function ApprovalCard({ card }: { card: Extract<ChatCard, { kind: 'approval' }> }) {
  return (
    <section data-chat-card="approval" style={box} aria-label="Proposed change">
      <p style={title}><ClipboardCheck className="w-3.5 h-3.5" aria-hidden /> Waiting for your approval{card.risk_level ? ` · ${card.risk_level} risk` : ''}</p>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)', whiteSpace: 'pre-line' }}>{card.preview}</p>
      <Link href={card.href} style={link}>Review it on Changes</Link>
    </section>
  )
}

export function ChatCards({ cards }: { cards: readonly ChatCard[] }) {
  return (
    <>
      {cards.map((card, i) => {
        if (card.kind === 'copy') return <CopyCard key={i} card={card} />
        if (card.kind === 'plan') return <PlanCard key={i} card={card} />
        if (card.kind === 'approval') return <ApprovalCard key={i} card={card} />
        return (
          <section key={i} data-chat-card="refusal" style={{ ...box, borderColor: 'var(--warning-border)' }} aria-label="Action not completed">
            <p style={{ ...title, color: 'var(--warning)' }}><ShieldAlert className="w-3.5 h-3.5" aria-hidden /> Not done</p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{card.message}</p>
          </section>
        )
      })}
    </>
  )
}
