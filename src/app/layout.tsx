import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { businessDisplayName } from '@/config/business-display'
import { Inter } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme/ThemeProvider'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Maxx',
  description: `AI Meta media buyer — ${businessDisplayName()}`,
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // src/proxy.ts sets a fresh CSP script nonce per request. Reading the request headers here also makes
  // every page render per request, which nonces require: a page prerendered at build time would carry
  // no nonce and its scripts would be blocked.
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    // suppressHydrationWarning is required by next-themes: it stamps data-theme on <html> before
    // React hydrates, so the server and client markup differ on that one attribute by design.
    <html lang="en" className={`${inter.variable} antialiased`} suppressHydrationWarning>
      <body style={{ fontFamily: 'var(--font-inter), Inter, system-ui, sans-serif' }}>
        <ThemeProvider nonce={nonce}>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
