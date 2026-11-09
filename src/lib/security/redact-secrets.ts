// Anything that looks like a credential, a signed URL or an e-mail address is stripped before a
// provider's text is stored, logged or returned. Signed paging and debug URLs carry access tokens in
// the query string; Meta user and system tokens start with "EA". PURE.

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/\S+/gi, '[url-redacted]'],
  [/\b(access_token|appsecret_proof|client_secret|token)\b\s*[=:]\s*\S+/gi, '$1=[redacted]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email-redacted]'],
  [/\bEA[A-Za-z0-9]{20,}\b/g, '[token-redacted]'],
]

/** Strip credentials, signed URLs and e-mail addresses from a provider's text, then cap its length. */
export function redactSecretText(raw: string, maxLen = 200): string {
  let out = raw
  for (const [re, to] of REDACT_PATTERNS) out = out.replace(re, to)
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out
}
