// Optional starter list for the Competitors page ("Seed competitors" button, POST /api/competitors/seed).
// Ships EMPTY on purpose: competitor names, handles and page ids are your market research, not the
// product's. Add rows here (or use the Competitors form in the app) to pre-populate a fresh install.

export interface CompetitorSeedRow {
  name: string
  location: string
  website_url: string | null
  instagram_url?: string | null
  facebook_page_id?: string | null
  hourly_rate_low: number | null
  hourly_rate_high: number | null
  size_sqft: number | null
  notes: string | null
}

export interface CompetitorSeedObservation {
  source: 'market_research'
  observation_type: 'pricing' | 'competitive_gap' | 'creative' | 'offer'
  summary: string
  what_to_learn: string | null
  what_not_to_copy: string | null
  suggested_test: string | null
}

export const COMPETITOR_SEED: readonly CompetitorSeedRow[] = []

export const COMPETITOR_SEED_OBSERVATIONS: readonly CompetitorSeedObservation[] = []
