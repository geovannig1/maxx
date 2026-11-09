'use client'

import { Check, Lock, Pencil, CircleDot } from 'lucide-react'
import type { TrustLevel } from '@/lib/trust/trust'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// The Maxx semantic badge catalog. One tonal `Pill` base + the only sanctioned variants, so
// source / paid-organic / risk / status / write-mode / flag / mode / learning never drift in color or
// shape again (design-system §4). The trust chip is its own component (<TrustBadge>) — the trust
// variant of this same spec. (The shadcn <Badge> in ./Badge.tsx is left untouched; this is additive.)

export type PillTone = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'
export type PillSize = 'sm' | 'md'

interface PillPalette {
  color: string
  background: string
  border: string
  softBorder: string
}

const TONE_STYLE: Record<PillTone, PillPalette> = {
  success: { color: 'var(--success)', background: 'var(--success-bg)', border: 'var(--success)', softBorder: 'var(--success-border)' },
  warning: { color: 'var(--warning)', background: 'var(--warning-bg)', border: 'var(--warning)', softBorder: 'var(--warning-border)' },
  danger: { color: 'var(--danger)', background: 'var(--danger-bg)', border: 'var(--danger)', softBorder: 'var(--danger-border)' },
  info: { color: 'var(--info)', background: 'var(--info-bg)', border: 'var(--info)', softBorder: 'var(--info-border)' },
  accent: { color: 'var(--accent)', background: 'var(--accent-dim)', border: 'var(--accent)', softBorder: 'var(--border-focus)' },
  neutral: { color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: 'var(--border-hover)', softBorder: 'var(--border-hover)' },
}

function customPalette(color: string): PillPalette {
  if (color === 'var(--accent)') return TONE_STYLE.accent
  return {
    color,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    border: color,
    softBorder: `color-mix(in srgb, ${color} 35%, transparent)`,
  }
}

export function pillPalette({ tone = 'neutral', hex, soft = false }: { tone?: PillTone; hex?: string; soft?: boolean }): React.CSSProperties {
  const palette = hex ? customPalette(hex) : TONE_STYLE[tone]
  return {
    background: palette.background,
    border: `1px solid ${soft ? palette.softBorder : palette.border}`,
    color: palette.color,
  }
}

export function Pill({
  tone = 'neutral', hex, icon, children, size = 'sm', soft = false, title,
}: {
  tone?: PillTone
  hex?: string // explicit color, overrides tone (e.g. provenance markers)
  icon?: React.ReactNode
  children: React.ReactNode
  size?: PillSize
  soft?: boolean // softer border token instead of solid ink
  title?: string
}) {
  const h = size === 'md' ? 26 : 22
  const fs = size === 'md' ? 12 : 11.5
  const px = size === 'md' ? 10 : 8
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap"
      style={{
        height: h, padding: `0 ${px}px`, fontSize: fs, lineHeight: 1,
        ...pillPalette({ tone, hex, soft }),
      }}
      title={title}
    >
      {icon}
      {children}
    </span>
  )
}

const Dot = ({ color }: { color: string }) => <span style={{ width: 6, height: 6, borderRadius: 999, background: color, display: 'inline-block' }} />
const isz = (size: PillSize) => (size === 'md' ? 12 : 11)

// ── Provenance ────────────────────────────────────────────────────────────────────────────────────
/** outcome ledger (business truth) / GA confirmation-event telemetry (attribution context, not money) / Meta modelled estimate / computed.
 *  Estimate is NEUTRAL text + an amber ~ — never red. */
export function SourceBadge({ source, size = 'sm' }: { source: 'outcomes' | 'ga4' | 'meta' | 'computed'; size?: PillSize }) {
  if (source === 'outcomes') return <Pill tone="success" size={size} icon={<Check style={{ width: isz(size), height: isz(size) }} />} title={`Outcome ledger — authoritative active ${OW.many} and booked value across all sources.`}>the outcome source</Pill>
  if (source === 'ga4') return <Pill tone="neutral" size={size} icon={<span style={{ color: 'var(--warning)', fontWeight: 700 }}>~</span>} title={`GA4 — session/traffic and confirmation-event telemetry. No ${OW.one} identity means its event count/value is not ${OW.many}, revenue, CPA, or ROAS.`}>GA4</Pill>
  if (source === 'computed') return <Pill tone="neutral" size={size} title="Computed / derived (e.g. MER, pace)">ƒ calc</Pill>
  return <Pill tone="neutral" size={size} icon={<span style={{ color: 'var(--warning)', fontWeight: 700 }}>~</span>} title="Meta — modelled platform attribution under the configured window; useful for delivery, not authoritative business outcomes.">Meta</Pill>
}

/** Paid (indigo) vs Organic (teal) channel provenance — always the same two dots, app-wide. */
export function ChannelBadge({ source, size = 'sm' }: { source: 'paid' | 'organic'; size?: PillSize }) {
  const hex = source === 'paid' ? 'var(--accent)' : 'var(--organic-marker)'
  return <Pill hex={hex} soft size={size} icon={<Dot color={hex} />}>{source === 'paid' ? 'Paid' : 'Organic'}</Pill>
}

// ── Risk / status / write-mode / mode / learning / flags ────────────────────────────────────────────
export function RiskBadge({ level, size = 'sm' }: { level: 'low' | 'medium' | 'high'; size?: PillSize }) {
  const tone: PillTone = level === 'low' ? 'success' : level === 'medium' ? 'warning' : 'danger'
  return <Pill tone={tone} soft size={size}>{level === 'low' ? 'Low risk' : level === 'medium' ? 'Med risk' : 'High risk'}</Pill>
}

/** Pace/target verdict pill. tone carries the good/warn/bad judgment; dot optional. */
export function StatusBadge({ tone, children, dot = true, size = 'sm' }: { tone: PillTone; children: React.ReactNode; dot?: boolean; size?: PillSize }) {
  const color = TONE_STYLE[tone].color
  return <Pill tone={tone} soft size={size} icon={dot ? <Dot color={color} /> : undefined}>{children}</Pill>
}

/** Write-mode status. OFF = GREEN (safe — nothing auto-executes). ON = red (account can be mutated). */
export function WriteModeBadge({ enabled, size = 'sm' }: { enabled: boolean; size?: PillSize }) {
  return enabled
    ? <Pill tone="danger" size={size} icon={<Pencil style={{ width: isz(size), height: isz(size) }} />} title="Write mode is ON — actions can change the Meta account">Write mode ON</Pill>
    : <Pill tone="success" soft size={size} icon={<Lock style={{ width: isz(size), height: isz(size) }} />} title="Write mode is OFF — Maxx proposes, you dispose. Nothing changes the account automatically.">Write mode OFF</Pill>
}

export type FlagType = 'winner' | 'loser' | 'scale_candidate' | 'creative_refresh' | 'watchlist' | 'too_early'
const FLAG: Record<FlagType, { tone: PillTone; label: string }> = {
  winner: { tone: 'success', label: 'Favorable signal' },
  scale_candidate: { tone: 'accent', label: 'High-delivery signal' },
  loser: { tone: 'danger', label: 'Concerning signal' },
  creative_refresh: { tone: 'warning', label: 'Fatigue signal' },
  watchlist: { tone: 'info', label: 'Watch signal' },
  too_early: { tone: 'neutral', label: 'Too early' },
}
export function flagDiagnosticLabel(type: string): string {
  return FLAG[type as FlagType]?.label ?? type.replaceAll('_', ' ')
}
export function FlagBadge({ type, size = 'sm' }: { type: FlagType; size?: PillSize }) {
  const f = FLAG[type] ?? { tone: 'neutral' as PillTone, label: type }
  return <Pill tone={f.tone} soft size={size}>{f.label}</Pill>
}

export type DataMode = 'pre_launch' | 'low_data' | 'active_learning' | 'sufficient'
const MODE: Record<DataMode, { tone: PillTone; label: string }> = {
  pre_launch: { tone: 'warning', label: 'Pre-launch' },
  low_data: { tone: 'warning', label: 'Low-data' },
  active_learning: { tone: 'info', label: 'Active-learning' },
  sufficient: { tone: 'success', label: 'Sufficient-data' },
}
export function ModeBadge({ mode, size = 'sm' }: { mode: DataMode; size?: PillSize }) {
  const m = MODE[mode] ?? { tone: 'neutral' as PillTone, label: mode }
  return <Pill tone={m.tone} soft size={size}>{m.label}</Pill>
}

export function LearningBadge({ size = 'sm' }: { size?: PillSize }) {
  return <Pill tone="info" soft size={size} icon={<CircleDot style={{ width: isz(size), height: isz(size) }} />}>Learning</Pill>
}

/** Inert count/filter tag, e.g. "All 12". */
export function CountBadge({ children, size = 'sm' }: { children: React.ReactNode; size?: PillSize }) {
  return <Pill tone="neutral" size={size}>{children}</Pill>
}

// Trust-tier color for callers that need the hex (e.g. a row cell). The chip itself is <TrustBadge>.
export const TRUST_HEX: Record<TrustLevel, string> = {
  verified: 'var(--success)', high: 'var(--accent)', moderate: 'var(--warning)', low: 'var(--trust-low)', insufficient: 'var(--text-tertiary)',
}
