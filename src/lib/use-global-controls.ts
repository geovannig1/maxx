'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { DATE_PRESETS, resolveDatePreset, resolveRange } from '@/lib/date-range'
import type { DateRangeValue } from '@/components/ui/DateRangeControl'
import type { TrafficSource } from '@/lib/ga4/client'

// The global date-range + source state that persists across navigation (design-system §6.1, audit #1/#2).
// Source of truth = URL params (range/from/to/source); localStorage backs them up so a page navigated-to
// without params restores the last selection. On mount, if the URL lacks the params but storage has
// them, we replace the URL so SERVER pages (dashboard, reports) re-render with the persisted choice.
// One control, everywhere — instead of four inconsistent per-page controls.

const LS_RANGE = 'maxx.range.v1'
const LS_SOURCE = 'maxx.source.v1'

function defaultRange(): DateRangeValue {
  const r = resolveDatePreset('1m')
  return { preset: '1m', from: r.from, to: r.to }
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

export function normalizeGlobalDateRange(value: unknown, now: Date = new Date()): DateRangeValue | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { preset?: unknown; from?: unknown; to?: unknown }
  if (record.preset === 'custom') {
    if (!isCalendarDate(record.from) || !isCalendarDate(record.to)) return null
    const resolved = resolveRange({ from: record.from, to: record.to }, '1m', now)
    return resolved.preset === 'custom' && !resolved.invalidCustom
      ? { preset: 'custom', from: resolved.from, to: resolved.to }
      : null
  }
  if (typeof record.preset !== 'string') return null
  const preset = DATE_PRESETS.find((candidate) => candidate.key === record.preset)?.key
  if (!preset) return null
  const resolved = resolveDatePreset(preset, now)
  return { preset, from: resolved.from, to: resolved.to }
}

export interface GlobalControlParams {
  range: DateRangeValue | null
  source: TrafficSource | null
  hasDateParams: boolean
  hasSourceParam: boolean
}

const NO_GLOBAL_TRAFFIC_SOURCE_ROUTES = ['/dashboard', '/performance', '/creative', '/reports', '/decisions', '/activity', '/truth']
const SAVED_REPORT_ROUTES = ['/dashboard', '/performance', '/creative', '/reports']

export function isSavedReportingView(pathname: string, search: string | URLSearchParams): boolean {
  return SAVED_REPORT_ROUTES.includes(pathname) && new URLSearchParams(search).has('saved')
}

/** The traffic selector describes GA traffic only. Multi-source report routes must not imply that it
 * also filters Meta delivery or all-source business outcome facts. */
export function showsGlobalTrafficSource(pathname: string): boolean {
  return !NO_GLOBAL_TRAFFIC_SOURCE_ROUTES.some(route => pathname === route || pathname.startsWith(`${route}/`))
}

export function readGlobalControlParams(
  search: string | URLSearchParams,
  now: Date = new Date(),
): GlobalControlParams {
  const p = typeof search === 'string' ? new URLSearchParams(search) : new URLSearchParams(search)
  let range: DateRangeValue | null = null
  const preset = p.get('range')
  const from = p.get('from')
  const to = p.get('to')
  // Explicit dates answer a more exact question and therefore win even if a stale preset remains.
  if (from || to) {
    range = normalizeGlobalDateRange({ preset: 'custom', from, to }, now)
  } else if (preset) {
    range = normalizeGlobalDateRange({ preset }, now)
  }
  const s = p.get('source')
  const source: TrafficSource | null = s === 'paid' || s === 'organic' || s === 'complete' ? s : null
  return {
    range,
    source,
    hasDateParams: p.has('range') || p.has('from') || p.has('to'),
    hasSourceParam: p.has('source'),
  }
}

function readStored(): { range: DateRangeValue | null; source: TrafficSource | null } {
  try {
    const rRaw = localStorage.getItem(LS_RANGE)
    const sRaw = localStorage.getItem(LS_SOURCE)
    const range = rRaw ? normalizeGlobalDateRange(JSON.parse(rRaw)) : null
    const source: TrafficSource | null = sRaw === 'paid' || sRaw === 'organic' || sRaw === 'complete' ? sRaw : null
    return { range, source }
  } catch {
    return { range: null, source: null }
  }
}

export function buildGlobalControlsUrl(input: {
  pathname: string
  search: string | URLSearchParams
  range: DateRangeValue
  source: TrafficSource
}): string {
  const p = new URLSearchParams(input.search)
  if (isSavedReportingView(input.pathname, p)) return `${input.pathname}?${p}`
  p.delete('range'); p.delete('from'); p.delete('to')
  if (input.range.preset === 'custom') {
    p.set('from', input.range.from)
    p.set('to', input.range.to)
  } else {
    p.set('range', input.range.preset)
  }
  p.delete('source')
  if (showsGlobalTrafficSource(input.pathname) && input.source !== 'complete') p.set('source', input.source)
  const qs = p.toString()
  return `${input.pathname}${qs ? `?${qs}` : ''}`
}

/** Remove a traffic-only scope while leaving every other query value semantically unchanged. */
export function removeGlobalTrafficSourceFromUrl(
  pathname: string,
  search: string | URLSearchParams,
): string {
  const query = new URLSearchParams(search)
  query.delete('source')
  const serialized = query.toString()
  return `${pathname}${serialized ? `?${serialized}` : ''}`
}

/** Carry only global controls through shell navigation. Page-specific filters stay on their page. */
export function withGlobalControlParams(href: string, currentSearch: string | URLSearchParams): string {
  const hashAt = href.indexOf('#'), hash = hashAt === -1 ? '' : href.slice(hashAt)
  const route = hashAt === -1 ? href : href.slice(0, hashAt)
  const queryAt = route.indexOf('?'), pathname = queryAt === -1 ? route : route.slice(0, queryAt)
  const targetQuery = queryAt === -1 ? '' : route.slice(queryAt + 1)
  const current = new URLSearchParams(currentSearch)
  const target = new URLSearchParams(targetQuery)
  if (!SAVED_REPORT_ROUTES.includes(pathname)) target.delete('saved')
  else if (current.has('saved')) target.set('saved', current.get('saved')!)
  const from = current.get('from')
  const to = current.get('to')
  if (from || to) {
    if (from) target.set('from', from)
    if (to) target.set('to', to)
    target.delete('range')
  } else {
    const range = current.get('range')
    if (range) target.set('range', range)
  }
  target.delete('source')
  const source = current.get('source')
  if ((source === 'paid' || source === 'organic') && showsGlobalTrafficSource(pathname)) target.set('source', source)
  const query = target.toString()
  return `${pathname}${query ? `?${query}` : ''}${hash}`
}

export function useGlobalControls() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const search = searchParams.toString()
  const savedReport = isSavedReportingView(pathname, search)
  const [range, setRangeState] = useState<DateRangeValue>(defaultRange)
  const [source, setSourceState] = useState<TrafficSource>('complete')
  const [ready, setReady] = useState(false)
  const hydrated = useRef(false)
  const previousPathname = useRef(pathname)

  useEffect(() => {
    // URL/localStorage can only be resolved after client hydration. Re-run for search changes so
    // same-path navigation and browser Back update every consumer of this hook.
    const url = readGlobalControlParams(search)
    const stored = readStored()
    const changedPath = previousPathname.current !== pathname
    const mayRestore = !savedReport && (!hydrated.current || changedPath)
    const routeAllowsSource = showsGlobalTrafficSource(pathname)
    const r = url.range ?? (mayRestore ? stored.range : null) ?? defaultRange()
    const s = routeAllowsSource ? (url.source ?? (mayRestore ? stored.source : null) ?? 'complete') : 'complete'
    setRangeState(r)
    setSourceState(s)
    setReady(true)
    const restoreMissingControls = mayRestore && !url.hasDateParams && (stored.range || (stored.source && routeAllowsSource))
    const removeFalseSourceScope = !savedReport && url.hasSourceParam && !routeAllowsSource
    if (restoreMissingControls || removeFalseSourceScope) {
      const preserveMalformedCustom = removeFalseSourceScope && url.hasDateParams && url.range === null
      router.replace(preserveMalformedCustom
        ? removeGlobalTrafficSourceFromUrl(pathname, search)
        : buildGlobalControlsUrl({ pathname, search, range: r, source: s }), { scroll: false })
    }
    hydrated.current = true
    previousPathname.current = pathname
  }, [pathname, router, search, savedReport])

  const setRange = useCallback((v: DateRangeValue) => {
    if (savedReport) return
    const normalized = normalizeGlobalDateRange(v) ?? defaultRange()
    setRangeState(normalized)
    try { localStorage.setItem(LS_RANGE, JSON.stringify(normalized)) } catch { /* quota/disabled */ }
    router.push(buildGlobalControlsUrl({ pathname, search, range: normalized, source }), { scroll: false })
  }, [router, pathname, search, source, savedReport])

  const setSource = useCallback((s: TrafficSource) => {
    if (savedReport) return
    setSourceState(s)
    try { localStorage.setItem(LS_SOURCE, s) } catch { /* quota/disabled */ }
    router.push(buildGlobalControlsUrl({ pathname, search, range, source: s }), { scroll: false })
  }, [router, pathname, search, range, savedReport])

  return { range, source, setRange, setSource, ready, savedReport }
}
