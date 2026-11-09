'use client'

import { createContext, useContext, useState } from 'react'

// Shares the mobile-sidebar open/close state between the Topbar (hamburger) and the Sidebar (drawer),
// which are siblings under the dashboard layout. Desktop (≥lg) ignores this — the sidebar is static.
interface MobileNavState {
  open: boolean
  setOpen: (v: boolean) => void
}

const MobileNavContext = createContext<MobileNavState>({ open: false, setOpen: () => {} })

export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return <MobileNavContext.Provider value={{ open, setOpen }}>{children}</MobileNavContext.Provider>
}

export function useMobileNav(): MobileNavState {
  return useContext(MobileNavContext)
}
