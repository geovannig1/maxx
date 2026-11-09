'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'

/**
 * The theme provider, mounted for the first time.
 *
 * `next-themes` has been a dependency all along and `ui/sonner.tsx` has been calling `useTheme()`
 * against no provider, so it silently resolved to the default on every render. Mounting it here is
 * what makes that call mean anything, and what lets a toggle reach the palette.
 *
 * `attribute="data-theme"` matches the selectors in globals.css exactly.
 *
 * The default is `dark` by owner decision (2026-08-22): this is a cockpit, read in the morning and
 * often in a dim room, and dark is the intended look rather than an opt-in. `enableSystem` stays on
 * so the toggle can still reach system and light, and globals.css still defines the dark block both
 * as a media query and as a `[data-theme]` selector — the former covers a viewer on `system`, the
 * latter the stamped default and an explicit choice.
 *
 * `disableTransitionOnChange` suppresses the cross-fade every transition-bearing element would
 * otherwise run at once while the whole palette swaps.
 *
 * `nonce` is the request's CSP script nonce (root layout, from src/proxy.ts): next-themes renders an
 * inline script that the Content-Security-Policy blocks without it.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      nonce={nonce}
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}
