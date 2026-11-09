'use client'

import { ImageIcon } from 'lucide-react'

interface PlacementPreviewProps {
  thumbnailUrl: string | null
  adName: string
}

export function PlacementPreview({ thumbnailUrl, adName }: PlacementPreviewProps) {
  return (
    <div className="space-y-0">
      <p className="section-label" style={{ marginBottom: '12px' }}>Placement Preview</p>
      <p style={{ margin: '0 0 12px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
        Creative-only preview — advertiser copy, CTA, and destination are omitted because no verified CampaignPlan context was loaded.
      </p>

      <div style={{ display: 'flex', gap: '24px', overflowX: 'auto' }}>
        {/* FEED frame */}
        <div>
          <div style={{ width: '220px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
            {/* Post header mock */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--border-focus)' }} />
              <div>
                <p style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>Ad preview</p>
                <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', margin: 0 }}>Sponsored</p>
              </div>
            </div>
            {/* Image area */}
            <div style={{ width: '220px', height: '220px', background: 'var(--bg-base)', position: 'relative', overflow: 'hidden' }}>
              {thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbnailUrl} alt={adName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ImageIcon style={{ width: '32px', height: '32px', color: 'var(--text-disabled)' }} />
                </div>
              )}
            </div>
          </div>
          <p className="section-label" style={{ marginTop: '8px', textAlign: 'center' }}>Feed</p>
        </div>

        {/* REELS frame */}
        <div>
          <div style={{ width: '140px', height: '248px', background: '#000', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
            {/* Background image */}
            {thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnailUrl} alt={adName} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
            )}
            {/* Safe zone top band (15%) */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '15%', background: 'var(--danger-bg)', borderBottom: '1px dashed var(--danger-border)' }} />
            {/* Safe zone bottom band (20%) */}
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '20%', background: 'var(--danger-bg)', borderTop: '1px dashed var(--danger-border)' }} />
            {/* Bottom gradient */}
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '60%', background: 'linear-gradient(transparent, rgba(16,24,40,0.10))' }} />
            {/* Bottom UI mock */}
            <div style={{ position: 'absolute', bottom: '8px', left: '8px', right: '8px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(99,102,241,0.6)' }} />
                <span style={{ fontSize: '9px', color: '#fff', fontWeight: 600 }}>Ad preview</span>
              </div>
            </div>
          </div>
          <p className="section-label" style={{ marginTop: '8px', textAlign: 'center' }}>Reels</p>
        </div>

        {/* STORIES frame */}
        <div>
          <div style={{ width: '140px', height: '248px', background: '#000', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
            {thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnailUrl} alt={adName} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
            )}
            {/* Top gradient */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '30%', background: 'linear-gradient(rgba(16,24,40,0.08), transparent)' }} />
            {/* Progress bars */}
            <div style={{ position: 'absolute', top: '8px', left: '8px', right: '8px', display: 'flex', gap: '3px' }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ flex: 1, height: '2px', background: 'rgba(255,255,255,0.4)', borderRadius: '1px' }} />
              ))}
              <div style={{ flex: 1, height: '2px', background: 'var(--accent)', borderRadius: '1px' }} />
            </div>
            {/* Top header */}
            <div style={{ position: 'absolute', top: '16px', left: '8px', right: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(99,102,241,0.6)' }} />
              <div>
                <p style={{ margin: 0, fontSize: '9px', color: '#fff', fontWeight: 600 }}>Ad preview</p>
                <p style={{ margin: 0, fontSize: '8px', color: 'rgba(255,255,255,0.6)' }}>Sponsored</p>
              </div>
            </div>
          </div>
          <p className="section-label" style={{ marginTop: '8px', textAlign: 'center' }}>Stories</p>
        </div>
      </div>

      {thumbnailUrl && (
        <p style={{ marginTop: '12px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
          Warning: Red zones in Reels/Stories indicate where Meta UI overlays appear. Keep key text and visuals in the center 70% of the frame.
        </p>
      )}
    </div>
  )
}
