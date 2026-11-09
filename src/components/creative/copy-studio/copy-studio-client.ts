// Browser-side helpers for the Copy studio: typed request functions (one place that knows the routes
// and their failure shapes) and the plain-text form of a variant for the clipboard. No React here, so
// the suite can pin them without a DOM.

import type { CopyBriefInput } from '@/lib/creative/copy-brief'
import type { CopyScore, CopySetScore, CopyVariantInput } from '@/lib/creative/copy-scorer'
import type { GenerateCopyResult } from '@/lib/creative/copy-generator'
import { ctaLabel, type AudienceTemperature, type CopyAngle, type CopyGoal } from '@/lib/creative/copy-rules'

export type RequestOutcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string | null; message: string }

const FALLBACK = 'The request failed. Try again.'

async function postJson<T>(path: string, body: unknown): Promise<RequestOutcome<T>> {
  let response: Response
  try {
    response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', message: 'Maxx could not be reached. Check your connection and try again.' }
  }
  let json: Record<string, unknown> = {}
  try { json = await response.json() as Record<string, unknown> } catch { /* an empty or non-JSON body keeps the fallback */ }
  if (response.ok) return { ok: true, value: json as T }
  const message = typeof json.error === 'string' ? json.error : response.status === 429 ? 'Too many requests. Wait a few minutes and try again.' : FALLBACK
  return { ok: false, status: response.status, code: typeof json.code === 'string' ? json.code : null, message }
}

export function requestGenerate(brief: CopyBriefInput): Promise<RequestOutcome<Extract<GenerateCopyResult, { status: 'ok' }>>> {
  return postJson('/api/creative/copy/generate', brief)
}

export function requestScoreText(text: string, goal?: CopyGoal): Promise<RequestOutcome<{ score: CopyScore }>> {
  return postJson('/api/creative/copy/score', goal ? { text, goal } : { text })
}

export function requestScoreVariants(variants: CopyVariantInput[], goal?: CopyGoal): Promise<RequestOutcome<CopySetScore>> {
  return postJson('/api/creative/copy/score', goal ? { variants, goal } : { variants })
}

export interface SaveableVariant {
  hook: string; primary_text: string; headline: string; description: string; cta: string; angle: CopyAngle
}

export function requestSave(variant: SaveableVariant, goal: CopyGoal, temperature: AudienceTemperature): Promise<RequestOutcome<{ status: 'saved'; rows: number; score: CopyScore }>> {
  const { hook, primary_text, headline, description, cta, angle } = variant
  return postJson('/api/creative/copy/bank', { variant: { hook, primary_text, headline, description, cta, angle }, goal, temperature })
}

/** The variant as plain text, labelled, ready to paste into Ads Manager or a doc. */
export function variantClipboardText(v: CopyVariantInput): string {
  return [
    v.primary_text ? `Primary text:\n${v.primary_text}` : v.hook ? `Hook:\n${v.hook}` : null,
    v.headline ? `Headline: ${v.headline}` : null,
    v.description ? `Description: ${v.description}` : null,
    v.cta ? `Button: ${ctaLabel(v.cta)}` : null,
  ].filter(Boolean).join('\n\n')
}
