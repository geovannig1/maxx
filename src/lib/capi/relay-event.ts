// NOTE: the first-party browser relay this file was named for was REMOVED (2026-07-18). The file is
// retained (not renamed — surgical) solely for buildFbc, which the server-side outcome CAPI sender uses to
// reconstruct fbc from a captured fbclid.

/** Reconstruct Meta's `fbc` from a captured fbclid when the browser's _fbc cookie was blocked/missing.
 *  Format: fb.1.<creation_ms>.<fbclid> (subdomain index 1). Returns null for an empty fbclid.
 *  Used by the server-side outcome conversion senders. */
export function buildFbc(fbclid: string | null | undefined, creationMs: number): string | null {
  const id = (fbclid ?? '').trim()
  return id ? `fb.1.${creationMs}.${id}` : null
}
