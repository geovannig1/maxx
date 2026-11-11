// Fictional creative images that `npm run demo` serves from the page's own origin. A report creative's
// image is otherwise an https URL (Meta's CDN); a loopback https server needs a certificate an ordinary
// browser does not trust, so the demo's images are same-origin paths instead. The shape is narrow on
// purpose: one directory, a plain file name, an image extension, no host, no `..`, no query.

export const SAMPLE_MEDIA_PREFIX = '/sample-media/'

const SAMPLE_MEDIA_PATH = /^\/sample-media\/[a-z0-9-]+\.(?:svg|png)$/

export function isSampleMediaPath(value: string): boolean {
  return SAMPLE_MEDIA_PATH.test(value)
}
