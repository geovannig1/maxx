import { metaGet, metaGetPaginated } from './client'
import type { MetaAdAccount } from '@/types/meta-api'

const ACCOUNT_FIELDS = [
  'id',
  'name',
  'currency',
  'account_status',
  'timezone_name',
  'business',
  'spend_cap',
  'amount_spent',
  'disable_reason',
].join(',')

async function fetchPixelId(accountId: string): Promise<string | null> {
  try {
    const pixels = await metaGetPaginated<{ id: string }>(
      `/act_${accountId}/adspixels`,
      { fields: 'id', limit: '1' }
    )
    return pixels[0]?.id ?? null
  } catch {
    // 403 = token lacks pixel permissions — not fatal
    return null
  }
}

async function fetchInstagramAccountId(accountId: string): Promise<string | null> {
  try {
    const accounts = await metaGetPaginated<{ id: string }>(
      `/act_${accountId}/instagram_accounts`,
      { fields: 'id', limit: '1' }
    )
    return accounts[0]?.id ?? null
  } catch {
    return null
  }
}

async function fetchFacebookPageId(accountId: string): Promise<string | null> {
  try {
    const pages = await metaGetPaginated<{ id: string }>(
      `/act_${accountId}/pages`,
      { fields: 'id', limit: '1' }
    )
    return pages[0]?.id ?? null
  } catch {
    return null
  }
}

export async function fetchAdAccount(accountId: string): Promise<MetaAdAccount> {
  const [account, pixelId, instagramAccountId, facebookPageId] = await Promise.all([
    metaGet<MetaAdAccount>(`/act_${accountId}`, { fields: ACCOUNT_FIELDS }),
    fetchPixelId(accountId),
    fetchInstagramAccountId(accountId),
    fetchFacebookPageId(accountId),
  ])

  return {
    ...account,
    pixel_id: pixelId,
    instagram_account_id: instagramAccountId,
    facebook_page_id: facebookPageId,
  }
}
