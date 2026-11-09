export class ReportingRequestError extends Error {
  constructor(message: string, readonly kind: 'access' | 'invalid' | 'transient') {
    super(message)
    this.name = 'ReportingRequestError'
  }
}
