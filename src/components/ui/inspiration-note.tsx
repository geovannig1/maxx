import { Lightbulb } from 'lucide-react'

// Frames competitor/expert AI output as inspiration for TESTS — never proven strategy. Maxx must
// not present competitor observations or expert opinions as fact (see CONTRIBUTING.md ground rules).
export function InspirationNote({ children }: { children?: React.ReactNode }) {
  return (
    <div
      className="owner-notice"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: '9px',
        padding: '12px 14px', borderRadius: '10px', fontSize: '12.5px',
        background: 'var(--info-bg)', border: '1px solid var(--info-border)',
        color: 'var(--text-secondary)',
      }}
    >
      <Lightbulb style={{ width: '15px', height: '15px', color: 'var(--info)', flexShrink: 0, marginTop: '1px' }} />
      <span>
        {children ?? (
          <>
            <strong style={{ color: 'var(--text-primary)' }}>Inspiration, not proven strategy.</strong>{' '}
            Competitor &amp; expert insights below are outside-account ideas to <strong>test</strong> — not facts about your account. Long-running
            ads aren&apos;t proof of profit. Maxx never copies competitors; validate every idea against your own data.
          </>
        )}
      </span>
    </div>
  )
}
