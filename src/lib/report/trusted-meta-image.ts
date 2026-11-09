import { lookup as dnsLookup } from 'node:dns/promises'
import { isPublicAddress } from '@/lib/security/public-address'

const DEFAULT_MAX_BYTES = 3_750_000
const MAX_REDIRECTS = 3
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const TRUSTED_HOST_SUFFIXES = ['fbcdn.net', 'cdninstagram.com']

type LookupResult = { address: string; family: number }

interface TrustedImageDependencies {
  fetcher?: typeof fetch
  lookup?: (hostname: string) => Promise<LookupResult[]>
  maxBytes?: number
}

function trustedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return TRUSTED_HOST_SUFFIXES.some((suffix) => (
    normalized === suffix || normalized.endsWith(`.${suffix}`)
  ))
}

async function defaultLookup(hostname: string): Promise<LookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

async function validateTarget(
  target: URL,
  lookup: (hostname: string) => Promise<LookupResult[]>,
): Promise<void> {
  if (target.protocol !== 'https:') throw new Error('Image URL must use HTTPS.')
  if (target.username || target.password || target.port) {
    throw new Error('Image URL authority is not allowed.')
  }
  if (!trustedHostname(target.hostname)) {
    throw new Error('Image URL is not on an approved Meta CDN host.')
  }
  const addresses = await lookup(target.hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Image URL did not resolve exclusively to a public address.')
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error('Image response is too large.')
    }
  }
  if (!response.body) throw new Error('Image response body is missing.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Image response is too large.')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export async function fetchTrustedMetaImage(
  imageUrl: string,
  dependencies: TrustedImageDependencies = {},
): Promise<{
  bytes: Buffer
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}> {
  const fetcher = dependencies.fetcher ?? fetch
  const lookup = dependencies.lookup ?? defaultLookup
  const maxBytes = dependencies.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error('Image byte limit is invalid.')
  }

  let target = new URL(imageUrl)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await validateTarget(target, lookup)
    const response = await fetcher(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'image/jpeg,image/png,image/gif,image/webp' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirects === MAX_REDIRECTS) {
        throw new Error('Image redirect chain is invalid or too long.')
      }
      target = new URL(location, target)
      continue
    }
    if (!response.ok) throw new Error(`Image host returned HTTP ${response.status}.`)
    const mediaType = response.headers.get('content-type')?.split(';')[0].trim() ?? ''
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) throw new Error('Image media type is not supported.')
    return {
      bytes: await readBoundedBody(response, maxBytes),
      mediaType: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
    }
  }
  throw new Error('Image redirect chain is too long.')
}
