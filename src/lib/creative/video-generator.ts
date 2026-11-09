import 'server-only'
import { requireVerifiedCampaignPlanForCreative } from './campaign-plan-gate'
import { AiDisabledError, aiStatus } from '@/lib/ai'

const CREATIFY_BASE = 'https://api.creatify.ai/api'

function getApiKey(): string {
  // Creatify is a generative-AI vendor outside the text gateway; AI off means it is off too.
  if (aiStatus().state === 'off') throw new AiDisabledError('off')
  const key = process.env.CREATIFY_API_KEY
  if (!key) throw new Error('CREATIFY_API_KEY not configured. Add it to .env.local to enable UGC video generation.')
  return key
}

export interface CreatifyAvatar {
  id: string
  name: string
  thumbnail_url: string
  gender: string
  style: string
}

export interface CreatifyVideo {
  id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  video_url: string | null
  thumbnail_url: string | null
}

export async function getAvailableAvatars(): Promise<CreatifyAvatar[]> {
  const key = getApiKey()
  const res = await fetch(`${CREATIFY_BASE}/avatars/`, {
    headers: { 'X-API-KEY': key, 'X-API-ID': key },
  })
  if (!res.ok) throw new Error(`Creatify avatars API error: ${res.status}`)
  const data = await res.json() as { results?: CreatifyAvatar[] } | CreatifyAvatar[]
  return Array.isArray(data) ? data : (data.results ?? [])
}

export async function createUGCVideo(_params: {
  script: string
  avatar_id: string
  aspect_ratio?: string
  voice_id?: string
}): Promise<{ job_id: string }> {
  void _params
  return requireVerifiedCampaignPlanForCreative()
}

export async function checkVideoStatus(jobId: string): Promise<CreatifyVideo> {
  const key = getApiKey()
  const res = await fetch(`${CREATIFY_BASE}/lipsyncs/${jobId}/`, {
    headers: { 'X-API-KEY': key, 'X-API-ID': key },
  })
  if (!res.ok) throw new Error(`Creatify status check error: ${res.status}`)
  return res.json() as Promise<CreatifyVideo>
}
