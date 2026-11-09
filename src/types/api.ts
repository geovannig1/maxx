// ============================================================
// Internal API request / response types
// ============================================================

export interface SyncRequest {
  account_id?: string
  sync_type?: 'full' | 'incremental' | 'insights_only'
  date_range_start?: string
  date_range_end?: string
}

export interface SyncResponse {
  log_id: string
  status: string
  message: string
}

export interface CampaignsQuery {
  account_id?: string
  status?: string
  objective?: string
  date_start?: string
  date_end?: string
  sort?: 'spend' | 'leads' | 'cpl' | 'name'
  order?: 'asc' | 'desc'
  page?: number
  page_size?: number
}

export interface InsightsQuery {
  account_id: string
  entity_level: string
  entity_id?: string
  date_start: string
  date_end: string
  metrics?: string[]
}

export interface InsightAggregates {
  total_spend: number
  total_leads: number
  total_bookings: number
  total_clicks: number
  avg_ctr: number
  avg_cpm: number
  avg_cpl: number
  avg_cpb: number
}

export interface ApiErrorResponse {
  error: string
  code?: string
  field?: string
}
