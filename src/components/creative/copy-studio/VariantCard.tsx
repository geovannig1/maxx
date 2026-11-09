import type { CopyFinding, CopyScore } from '@/lib/creative/copy-scorer'
import { ANGLE_LABELS, ctaLabel, type CopyAngle } from '@/lib/creative/copy-rules'

// One ad variant with its deterministic score: the copy as it would run, the score with a text verdict
// (never colour alone), every finding with its fix, and optional actions. Presentational only, so it
// renders identically for generated variants, the copy bank, the demo samples and existing ads.

export interface VariantCardProps {
  title: string
  variant: { hook?: string | null; primary_text?: string | null; headline?: string | null; description?: string | null; cta?: string | null; angle?: string | null }
  score: CopyScore
  badge?: string
  rationale?: string | null
  busy?: boolean
  onCopy?: () => void
  onRegenerate?: () => void
  onSave?: () => void
  saved?: boolean
}

const VERDICT: Record<CopyScore['verdict'], { label: string; color: string }> = {
  strong: { label: 'Strong', color: 'var(--success)' },
  good: { label: 'Good', color: 'var(--accent)' },
  needs_work: { label: 'Needs work', color: 'var(--warning)' },
  blocked: { label: 'Blocked', color: 'var(--danger)' },
}

function Finding({ f }: { f: CopyFinding }) {
  return (
    <li className="text-[12.5px]" style={{ lineHeight: 1.45 }} data-rule={f.rule}>
      <span className="font-semibold" style={{ color: f.severity === 'blocker' ? 'var(--danger)' : 'var(--warning)' }}>
        {f.severity === 'blocker' ? 'Blocker' : 'Fix'}:
      </span>{' '}
      <span style={{ color: 'var(--text-primary)' }}>{f.message}</span>{' '}
      <span style={{ color: 'var(--text-tertiary)' }}>{f.fix}</span>
    </li>
  )
}

const buttonStyle = { border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 12.5, background: 'var(--bg-surface)', color: 'var(--text-primary)' }

export function VariantCard({ title, variant, score, badge, rationale, busy, onCopy, onRegenerate, onSave, saved }: VariantCardProps) {
  const verdict = VERDICT[score.verdict]
  const angle = variant.angle && variant.angle in ANGLE_LABELS ? ANGLE_LABELS[variant.angle as CopyAngle] : variant.angle
  const body = variant.primary_text || variant.hook
  return (
    <article className="card-base p-4 space-y-3" aria-label={title} data-verdict={score.verdict}>
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            {[angle, badge].filter(Boolean).join(' · ')}
          </p>
        </div>
        <p className="text-[13px] font-semibold shrink-0" style={{ color: verdict.color }} aria-label={`Score ${score.score} out of 100, ${verdict.label}`}>
          {score.score}/100 · {verdict.label}
        </p>
      </header>

      <dl className="space-y-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
        {body && (<div><dt className="section-label">Primary text</dt><dd className="whitespace-pre-wrap break-words">{body}</dd></div>)}
        {variant.headline && (<div><dt className="section-label">Headline</dt><dd className="break-words">{variant.headline}</dd></div>)}
        {variant.description && (<div><dt className="section-label">Description</dt><dd className="break-words">{variant.description}</dd></div>)}
        {variant.cta && (<div><dt className="section-label">Button</dt><dd>{ctaLabel(variant.cta)}</dd></div>)}
      </dl>

      {rationale && <p className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}><span className="font-semibold">Why: </span>{rationale}</p>}

      <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
        Hook strength {score.metrics.hook_strength ?? 'n/a'}/100 · reading grade {score.metrics.readability_grade ?? 'n/a'} · headline {score.metrics.lengths.headline} chars
      </p>

      {score.findings.length > 0 ? (
        <ul className="space-y-1.5" aria-label="Findings">{score.findings.map((f, i) => <Finding key={`${f.rule}-${i}`} f={f} />)}</ul>
      ) : (
        <p className="text-[12.5px]" style={{ color: 'var(--success)' }}>No findings: within Meta limits, no unverified claims, no policy risk.</p>
      )}

      {(onCopy || onRegenerate || onSave) && (
        <div className="flex gap-2 flex-wrap">
          {onCopy && <button type="button" onClick={onCopy} style={buttonStyle} aria-label={`Copy ${title} to the clipboard`}>Copy</button>}
          {onRegenerate && <button type="button" onClick={onRegenerate} disabled={busy} style={buttonStyle} aria-label={`Regenerate the ${angle ?? ''} angle`}>Regenerate this angle</button>}
          {onSave && (
            <button type="button" onClick={onSave} disabled={busy || saved || !score.publishable} style={buttonStyle}
              aria-label={score.publishable ? `Save ${title} to the copy bank` : `${title} has a blocker and cannot be saved`}>
              {saved ? 'Saved' : score.publishable ? 'Save to bank' : 'Fix blockers to save'}
            </button>
          )}
        </div>
      )}
    </article>
  )
}
