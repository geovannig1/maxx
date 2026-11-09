'use client'
import { useEffect, useState } from 'react'
import { readSavedReport } from './saved-client'
import { ReportingRequestError } from './request-error'
import { SavedReportError, type OpenSavedReportingReportReply } from './saved-contract'

export function useSavedReport(id: string | null) {
  const [state, setState] = useState<{ id: string | null; value: OpenSavedReportingReportReply | null; error: string | null; denied: boolean }>({ id: null, value: null, error: null, denied: false })
  useEffect(() => {
    if (id === null) return
    const controller = new AbortController()
    void readSavedReport(id, controller.signal).then(value => {
      if (!controller.signal.aborted) setState({ id, value, error: null, denied: false })
    }).catch(error => {
      if (!controller.signal.aborted) setState({ id, value: null,
        error: error instanceof SavedReportError || error instanceof ReportingRequestError ? error.message : 'The saved report could not load. Retry opening it from Saved reports.',
        denied: error instanceof ReportingRequestError && error.kind === 'access' })
    })
    return () => controller.abort()
  }, [id])
  return state.id === id ? { ...state, loading: false } : { id, value: null, error: null, denied: false, loading: id !== null }
}
