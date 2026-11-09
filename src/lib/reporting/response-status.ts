import { ReportingRequestError } from './request-error'

export function checkReportingResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) throw new ReportingRequestError('Your session cannot access this report. Sign in with the owner account.', 'access')
  if (response.status === 400) throw new ReportingRequestError('Choose valid start and end dates that include a completed account day.', 'invalid')
  const code = response.headers.get('x-reporting-error-code')
  if (code === 'ACTIVE_ACCOUNT_AMBIGUOUS') throw new ReportingRequestError('More than one active account was found. Reporting ownership needs to be resolved.', 'invalid')
  if (code === 'ACTIVE_ACCOUNT_NOT_FOUND') throw new ReportingRequestError('No active reporting account is configured. Set exactly one active ad account before this report can load.', 'invalid')
  if (code === 'ACTIVE_ACCOUNT_UNAVAILABLE') throw new ReportingRequestError('Reporting account lookup is temporarily unavailable. Retry reports after the account source responds.', 'transient')
  if (response.status === 409) throw new ReportingRequestError('More than one active account was found. Reporting ownership needs to be resolved.', 'invalid')
  if (response.status === 404) throw new ReportingRequestError('Reporting account or refresh ownership could not be resolved.', 'invalid')
  if (!response.ok) throw new ReportingRequestError('This reporting source is temporarily unavailable. Retry this source.', 'transient')
}
