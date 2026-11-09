import {
  LayoutDashboard, ClipboardCheck, BarChart3, Activity,
  Rocket,
  Wand2, FileImage, BookOpen,
  Telescope, Building2, Rss,
  Inbox, GitPullRequest, ListChecks, ShieldCheck, Bot,
  Target, Layers, Image, PieChart, Zap, FlaskConical, FileText, History, Brain, Palette, Scale,
  Settings, PenLine, FileStack,
} from 'lucide-react'

// Single source of truth for navigation — shared by the Sidebar and the command palette.
// Prepared reporting is the owner's opening loop. Operational and historical tools remain visible
// below it, and granular drill destinations remain available in the palette.

export interface NavItemDef {
  label: string
  href: string
  icon: React.ElementType
  /** Sub-destinations shown indented under the item in the sidebar (and listed in the palette). */
  children?: NavItemDef[]
}

export interface NavSectionDef {
  title?: string
  items: NavItemDef[]
}

export const NAV: NavSectionDef[] = [
  {
    items: [
      { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
      {
        label: 'Ads', href: '/performance', icon: BarChart3,
        children: [
          { label: 'New campaign', href: '/campaigns/new', icon: Rocket },
          { label: 'Campaign plans', href: '/campaigns/plans', icon: FileStack },
        ],
      },
      {
        label: 'Creative', href: '/creative', icon: Palette,
        children: [{ label: 'Copy studio', href: '/creative/copy', icon: PenLine }],
      },
      { label: 'Reports', href: '/reports', icon: FileText },
    ],
  },
  {
    title: 'SECONDARY',
    items: [
      { label: 'Measurement',  href: '/truth',       icon: Scale },
      { label: 'Decisions',    href: '/decisions',   icon: ClipboardCheck },
      { label: 'Activity',     href: '/activity',    icon: Activity },
      { label: 'Experiments',  href: '/experiments', icon: FlaskConical },
      { label: 'Diagnostics',  href: '/diagnostics', icon: ShieldCheck },
      { label: 'Launch setup', href: '/launch',      icon: Rocket },
      { label: 'Settings',     href: '/settings',    icon: Settings },
      { label: 'Ask Maxx',     href: '/maxx',        icon: Bot },
    ],
  },
]

// The granular tab destinations — not sidebar items, but jumpable from ⌘K.
const TAB_DESTINATIONS: NavItemDef[] = [
  { label: 'Campaigns',        href: '/performance/campaigns', icon: Target },
  { label: 'Ad Sets',          href: '/performance/adsets',    icon: Layers },
  { label: 'Ads',              href: '/performance/ads',       icon: Image },
  { label: 'Segments',         href: '/performance/segments',  icon: PieChart },
  { label: 'Flags',            href: '/performance/flags',     icon: Zap },
  { label: 'Report history',   href: '/activity/reports',      icon: FileText },
  { label: 'Lifecycle timeline', href: '/activity/change-log', icon: History },
  { label: 'Learnings',        href: '/activity/learnings',    icon: Brain },
]

const PALETTE_ONLY_DESTINATIONS: NavItemDef[] = [
  { label: 'Recommendation decisions', href: '/decisions?view=needs_review', icon: ClipboardCheck },
  { label: 'Inbox notifications', href: '/decisions?view=tracking_repair&legacy=inbox', icon: Inbox },
  { label: 'Approvals',       href: '/approvals', icon: ClipboardCheck },
  { label: 'Pending Changes', href: '/changes', icon: GitPullRequest },
  { label: 'Create',          href: '/create',  icon: Wand2 },
  { label: 'Briefs',          href: '/briefs',  icon: FileImage },
  { label: 'Hooks',           href: '/hooks',   icon: BookOpen },
  { label: 'Discovery',       href: '/discovery',   icon: Telescope },
  { label: 'Competitors',     href: '/competitors', icon: Building2 },
  { label: 'Signals',         href: '/signals',     icon: Rss },
  { label: 'Conversions',     href: '/conversions', icon: ListChecks },
]

// Flattened destination list (sidebar items + tab destinations + Settings) for the command palette.
export const ALL_NAV_ITEMS: NavItemDef[] = [
  ...NAV.flatMap((s) => s.items.flatMap((item) => [item, ...(item.children ?? [])])),
  ...TAB_DESTINATIONS,
  ...PALETTE_ONLY_DESTINATIONS,
]
