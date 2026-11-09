export type BoundedBody =
  | { ok: true; rawBody: string }
  | { ok: false; error: 'invalid_content_length' | 'too_large' | 'unreadable' }

/**
 * Read a request body as UTF-8 text, refusing it before buffering more than `maxBytes`. A declared
 * Content-Length is checked first; the stream is then counted, because the header can be absent or
 * wrong. Used by public, signature-authenticated endpoints, where an unsigned caller must not be able
 * to make the server buffer an unbounded body before the signature is checked.
 */
export async function readBoundedBody(req: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = req.headers.get('content-length')
  if (declared != null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: 'invalid_content_length' }
    if (size > maxBytes) return { ok: false, error: 'too_large' }
  }
  if (!req.body) return { ok: true, rawBody: '' }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('body exceeds byte limit')
        return { ok: false, error: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, error: 'unreadable' }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, rawBody: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
}
