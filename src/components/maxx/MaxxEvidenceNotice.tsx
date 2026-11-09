import { EvidenceMeta } from '@/components/sources/EvidenceMeta'

export const MAXX_NUMERIC_ANSWER_CONTRACT = {
  requiredFields: ['value', 'source', 'sourceRole', 'dateWindow', 'scope', 'freshness', 'confidence', 'caveat'],
  neverBlend: ['outcome_business_truth', 'ga4_confirmation_telemetry', 'meta_modelled_attribution'],
} as const

export function MaxxEvidenceNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="rounded-xl"
      style={{
        padding: compact ? '10px 12px' : '14px 16px',
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border)',
      }}
    >
      <p className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        Numeric answers require source, date, scope, freshness, confidence, and caveat.
      </p>
      <p className="text-[11.5px] leading-relaxed mt-1" style={{ color: 'var(--text-tertiary)' }}>
        Maxx never blends outcomes, GA4, and Meta: the outcome ledger is business truth, GA4 is confirmation telemetry,
        and Meta is delivery plus modelled attribution.
      </p>
      {!compact && (
        <div className="mt-3 space-y-1.5">
          <EvidenceMeta source="outcomes" role="business_truth" window="selected window" scope="account" confidence="business total" compact />
          <EvidenceMeta source="ga4" role="telemetry" window="selected window" scope="session/channel" confidence="not revenue" compact />
          <EvidenceMeta source="meta" role="modelled_attribution" window="selected window" scope="ad account" confidence="not business truth" compact />
        </div>
      )}
    </div>
  )
}
