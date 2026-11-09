import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs/config'
import { assertDemoAllowed } from './src/config/demo'

// Sample-data mode (`npm run demo`) never builds or runs in production or on Vercel.
assertDemoAllowed(process.env)

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // `next dev` would otherwise write an untracked AGENTS.md block at the repository root.
  agentRules: false,
  // No remote image patterns: nothing uses next/image, and any allowed remote host would make
  // /_next/image a public fetch-and-resize proxy for it.
  // gRPC-based GA4 client must not be bundled — keep it external on the server.
  serverExternalPackages: ['@google-analytics/data'],
  // Baseline response headers. The console approves live ad-account changes, so it must never be
  // framed; the rest are standard hardening. The Content-Security-Policy is NOT here: src/proxy.ts
  // sets it per request with a fresh script nonce (src/lib/security/csp.ts). A static copy here would
  // be a second, conflicting policy.
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
      ],
    }]
  },
}

// Browser source maps are never published. Without SENTRY_AUTH_TOKEN Sentry's source-map handling is
// disabled, so Next's default (no browser maps) stands. With it, Sentry enables map generation for the
// Turbopack build, uploads them, then deletes the .map files and strips their sourceMappingURL comments.
// productionBrowserSourceMaps is deliberately left unset: an explicit false stops Sentry from generating
// the maps it needs to upload.
export default withSentryConfig(nextConfig, {
  silent: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
})
