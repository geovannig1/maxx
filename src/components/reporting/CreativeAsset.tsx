'use client'

import { useState } from 'react'
import { ImageOff, Film } from 'lucide-react'
import type { ReportCreative } from '@/lib/reporting/contracts'
import { isSampleMediaPath } from '@/lib/reporting/sample-media'

function safeUrl(value?: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? value : null
  } catch { return null }
}

/** An image may also be a demo sample on the page's own origin (@/lib/reporting/sample-media). */
const safeImageUrl = (value?: string | null) => value && isSampleMediaPath(value) ? value : safeUrl(value)

export function CreativeAsset({ creative, name, compact = false, detailsLoading = false }: { creative: ReportCreative | null; name: string; compact?: boolean; detailsLoading?: boolean }) {
  const [failed, setFailed] = useState<string[]>([])
  const fail = (url: string) => setFailed(previous => previous.includes(url) ? previous : [...previous, url])
  const video = safeUrl(creative?.videoUrl)
  const image = [safeImageUrl(creative?.imageUrl), safeImageUrl(creative?.thumbnailUrl)].find(url => url && !failed.includes(url))
  const playable = video && !failed.includes(video) && !compact
  return <figure className="min-w-0">
    <div className={`relative flex items-center justify-center overflow-hidden rounded-lg bg-[var(--bg-subtle)] ${compact ? 'h-14 w-20' : 'aspect-[16/10] w-full'}`}>
      {playable ? <video controls playsInline preload="none" poster={image ?? undefined} src={video} aria-label={`Video creative: ${name}`}
        className="h-full w-full object-contain" onError={() => fail(video)} />
        : image ? <>
          {/* Meta supplies expiring external asset URLs; retain the original preview without proxying it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt={`Creative preview: ${name}`} loading="lazy" decoding="async" className="h-full w-full object-contain" onError={() => fail(image)} />
          {creative?.format === 'video' && !compact && <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded bg-[var(--bg-surface)] px-2 py-1 text-xs text-[var(--text-primary)]"><Film size={14} aria-hidden="true" />Video thumbnail</span>}
        </> : <div role="status" className={`flex flex-col items-center gap-2 text-center text-[var(--text-secondary)] ${compact ? 'p-1 text-[10px]' : 'max-w-64 p-6 text-sm'}`}>
          <ImageOff size={compact ? 18 : 28} aria-hidden="true" /><span>{detailsLoading && !failed.length ? 'Loading preview…' : 'Preview unavailable'}</span>
          {!compact && <span className="text-xs leading-5">{failed.length ? 'The asset could not load. Its ad identity and metrics remain available.' : detailsLoading ? 'Creative details are still loading from Meta.' : 'Meta did not supply a usable image or video for this ad.'}</span>}
        </div>}
    </div>
    {!compact && <figcaption className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-[var(--text-secondary)]">
      <span>{creative?.format === 'unknown' || !creative ? detailsLoading ? 'Format loading…' : 'Format unknown' : creative.format === 'video' ? 'Video' : creative.format === 'carousel' ? 'Carousel preview' : 'Image'}</span>
      {creative?.format === 'video' && <span>{creative.durationSeconds === null ? detailsLoading ? 'Duration loading…' : 'Duration unavailable' : `${creative.durationSeconds} seconds`}</span>}
      {creative?.format === 'video' && !playable && <span>{video && failed.includes(video) ? 'Video playback failed; preview shown when available.' : detailsLoading ? 'Video playback loading…' : 'Playable video not supplied.'}</span>}
      {playable && <span>Captions not supplied by Meta.</span>}
      {creative?.videoPreviewEvidence && <details className="basis-full">
        <summary className="cursor-pointer font-medium text-[var(--text-primary)]">Configured story-video preview</summary>
        <p className="mt-1 max-w-3xl">Meta video {creative.videoPreviewEvidence.videoId} is the exact readable member referenced by the current object-story specification; alternate video identities remain preserved, ad results are not assigned to this member, and placement-specific rendering may differ.</p>
      </details>}
    </figcaption>}
  </figure>
}
