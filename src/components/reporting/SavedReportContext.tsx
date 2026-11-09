'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { OpenSavedReportingReportReply, SavedReportSummary } from '@/lib/reporting/saved-contract'

const SavedContext = createContext<OpenSavedReportingReportReply | null>(null)
export function SavedReportProvider({ value, children }: { value: OpenSavedReportingReportReply | null; children: ReactNode }) {
  return <SavedContext.Provider value={value}>{children}</SavedContext.Provider>
}
export function useSavedReportContext() { return useContext(SavedContext) }
export function savedReportHref(href: string, savedId: string | null): string {
  if (!savedId || !href.startsWith('/') || href.startsWith('//')) return href
  const url = new URL(href, 'https://maxx.invalid')
  if (!['/dashboard', '/performance', '/creative', '/reports'].includes(url.pathname)) return href
  url.searchParams.set('saved', savedId)
  return `${url.pathname}${url.search}${url.hash}`
}
export function savedReportHome(saved: SavedReportSummary): string {
  return savedReportHref(`${saved.view.pathname}?${new URLSearchParams(saved.view.query)}${saved.view.hash ?? ''}`, saved.id)
}
