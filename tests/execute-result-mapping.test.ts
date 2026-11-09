import { describe, it, expect } from 'vitest'
import { httpStatusForExecuteResult } from '@/lib/writes/executor'
import { resultMessage } from '@/components/changes/ChangeReviewList'

// Review finding: executor failures (PREVIOUSLY_FAILED, IN_PROGRESS, NOT_APPROVED, ERROR) traveled as
// HTTP 200 and fell through to the UI's success message. Both layers are pinned here: failures get real
// HTTP codes, and every status renders a non-ok message unless it is genuinely a success.

describe('httpStatusForExecuteResult', () => {
  it('success statuses are 200', () => {
    for (const s of ['EXECUTED_VERIFIED', 'EXECUTED_UNVERIFIED', 'ALREADY_EXECUTED', 'ALREADY_APPLIED_UNVERIFIED', 'WRITE_MODE_DISABLED']) {
      expect(httpStatusForExecuteResult(s)).toBe(200)
    }
  })
  it('state conflicts are 409, missing is 404, Meta failure is 502, audit break/unknown are 500', () => {
    expect(httpStatusForExecuteResult('NOT_APPROVED')).toBe(409)
    expect(httpStatusForExecuteResult('IN_PROGRESS')).toBe(409)
    expect(httpStatusForExecuteResult('PREVIOUSLY_FAILED')).toBe(409)
    expect(httpStatusForExecuteResult('AUTHORITY_REQUIRED')).toBe(409)
    expect(httpStatusForExecuteResult('EXPIRED')).toBe(409)
    expect(httpStatusForExecuteResult('OWNERSHIP_UNVERIFIED')).toBe(409)
    expect(httpStatusForExecuteResult('OWNERSHIP_MISMATCH')).toBe(409)
    expect(httpStatusForExecuteResult('PRECONDITION_UNAVAILABLE')).toBe(409)
    expect(httpStatusForExecuteResult('STALE_APPROVAL')).toBe(409)
    expect(httpStatusForExecuteResult('NOT_FOUND')).toBe(404)
    expect(httpStatusForExecuteResult('FAILED')).toBe(502)
    expect(httpStatusForExecuteResult('AUDIT_INCOMPLETE')).toBe(500)
    expect(httpStatusForExecuteResult('ERROR')).toBe(500)
    expect(httpStatusForExecuteResult('SOMETHING_NEW')).toBe(500)
  })
})

describe('resultMessage — no failure ever reads as success', () => {
  const notOk = ['EXECUTED_UNVERIFIED', 'IN_PROGRESS', 'PREVIOUSLY_FAILED', 'NOT_APPROVED', 'AUTHORITY_REQUIRED', 'EXPIRED', 'OWNERSHIP_UNVERIFIED', 'OWNERSHIP_MISMATCH', 'PRECONDITION_UNAVAILABLE', 'STALE_APPROVAL', 'AUDIT_INCOMPLETE', 'FAILED', 'ERROR', undefined]
  it.each(notOk.map((s) => [s ?? '(unknown)']))('status %s → ok:false', (label) => {
    const status = label === '(unknown)' ? undefined : label
    expect(resultMessage('approve', status).ok).toBe(false)
  })
  it('genuine successes are ok, and a recorded approval NEVER reads like a live execution', () => {
    expect(resultMessage('approve', 'EXECUTED_VERIFIED').ok).toBe(true)
    expect(resultMessage('approve', 'ALREADY_EXECUTED').ok).toBe(true)
    const recorded = resultMessage('approve', 'approved')
    expect(recorded.ok).toBe(true)
    expect(recorded.text).toMatch(/not executed/i)
    const disabled = resultMessage('approve', 'WRITE_MODE_DISABLED')
    expect(disabled.ok).toBe(true)
    expect(disabled.text).toMatch(/NOT executed/i)
  })
  it('reject is always a plain success', () => {
    expect(resultMessage('reject', undefined)).toEqual({ text: 'Change rejected.', ok: true })
  })
})
