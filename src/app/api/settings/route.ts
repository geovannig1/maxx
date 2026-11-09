import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { z } from 'zod'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

const UNGOVERNED_SETTING_KEYS = new Set([
  'target_cpa',
  'avg_order_value',
  'main_conversion_event',
  'pixel_id',
  'read_only_mode',
  'weekly_auto_sync',
  'brand_tone',
  'instagram_handle',
  'competitor_tracking_enabled',
  'expert_tracker_enabled',
  'approved_write_mode',
  'performance_targets',
  'economics_inputs',
  'appointment_conversion_id',
])

type GeneralSetting = { key: string; [key: string]: unknown }

export function partitionSettingsForGeneralEditor<T extends GeneralSetting>(rows: T[]): {
  settings: T[]
  quarantined_settings: Array<{ key: string; reason_code: 'governed_elsewhere_or_unversioned' }>
} {
  return rows.reduce<{
    settings: T[]
    quarantined_settings: Array<{ key: string; reason_code: 'governed_elsewhere_or_unversioned' }>
  }>((result, row) => {
    if (UNGOVERNED_SETTING_KEYS.has(row.key)) {
      return {
        ...result,
        quarantined_settings: [
          ...result.quarantined_settings,
          { key: row.key, reason_code: 'governed_elsewhere_or_unversioned' },
        ],
      }
    }
    return { ...result, settings: [...result.settings, row] }
  }, { settings: [], quarantined_settings: [] })
}

function validateSettingValue(settingType: unknown, value: string): string | null {
  if (value.length > 10_000) return 'Setting value is too long.'
  if (settingType === 'boolean' && value !== 'true' && value !== 'false') {
    return 'Boolean settings accept only true or false.'
  }
  if (settingType === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) {
    return 'Number settings require a finite numeric value.'
  }
  if (settingType === 'json') {
    try {
      JSON.parse(value)
    } catch {
      return 'JSON settings require valid JSON.'
    }
  }
  return null
}

async function authenticateOwner(): Promise<Response | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  return ownerOnly(user)
}

async function resolveAccount(db: ReturnType<typeof getAdminClient>): Promise<{
  id: string | null
  error: Response | null
}> {
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (activeAccount.ok) return { id: activeAccount.account.id, error: null }

  const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
  return {
    id: null,
    error: Response.json({
      error: activeAccount.reason === 'not_found'
        ? 'No active ad account found'
        : activeAccount.reason === 'ambiguous'
          ? 'More than one active ad account is configured'
          : 'The active ad account could not be resolved',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status }),
  }
}

export async function GET() {
  const forbidden = await authenticateOwner()
  if (forbidden) return forbidden

  const db = getAdminClient()
  const account = await resolveAccount(db)
  if (!account.id) return account.error as Response

  const { data, error } = await db
    .from('app_settings')
    .select('*')
    .eq('ad_account_id', account.id)
    .order('key')
  if (error) return apiErrorResponse('GET /api/settings', 'SETTINGS_READ_FAILED', error, 500)

  const partitioned = partitionSettingsForGeneralEditor(data ?? [])
  return Response.json({
    ...partitioned,
    initialized: partitioned.settings.length > 0,
    provenance: {
      status: 'unversioned_app_settings',
      owner_approval_recorded: false,
      version_recorded: false,
    },
  })
}

const updateSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(10_000),
}).strict()

export async function PATCH(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const forbidden = await authenticateOwner()
  if (forbidden) return forbidden

  const body = await req.json().catch(() => ({}))
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: 'Invalid body', code: 'INVALID_BODY' }, { status: 400 })

  if (UNGOVERNED_SETTING_KEYS.has(parsed.data.key)) {
    return Response.json({
      error: 'This value is governed by a dedicated evidence or configuration surface and cannot be changed here.',
      code: 'UNGOVERNED_SETTING_KEY',
      key: parsed.data.key,
    }, { status: 409 })
  }

  const db = getAdminClient()
  const account = await resolveAccount(db)
  if (!account.id) return account.error as Response

  // General settings may update an existing low-risk row, but this endpoint may not mint new policy.
  const { data: existing, error: readError } = await db
    .from('app_settings')
    .select('id, setting_type')
    .eq('ad_account_id', account.id)
    .eq('key', parsed.data.key)
    .maybeSingle()
  if (readError) return apiErrorResponse('PATCH /api/settings', 'SETTINGS_READ_FAILED', readError, 500)
  if (!existing?.id) {
    return Response.json({
      error: 'Unknown general setting. New settings require a governed, typed configuration surface.',
      code: 'SETTING_NOT_FOUND',
    }, { status: 404 })
  }

  const invalidReason = validateSettingValue(existing.setting_type, parsed.data.value)
  if (invalidReason) return Response.json({ error: invalidReason, code: 'INVALID_SETTING_VALUE' }, { status: 400 })

  const { error } = await db
    .from('app_settings')
    .update({ value: parsed.data.value, updated_at: new Date().toISOString() })
    .eq('id', existing.id as string)
  if (error) return apiErrorResponse('PATCH /api/settings', 'SETTINGS_WRITE_FAILED', error, 500)

  return Response.json({
    ok: true,
    provenance: {
      status: 'unversioned_app_setting',
      owner_approval_recorded: false,
      version_recorded: false,
    },
  })
}

// The legacy initializer minted fixed CPA, AOV, conversion-event, pixel, and write-mode claims. Keep
// the route stable for old clients, but fail closed before any database access or mutation.
export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const forbidden = await authenticateOwner()
  if (forbidden) return forbidden

  return Response.json({
    error: 'Fixed default initialization is disabled. Configure targets, economics, tracking, and write mode through their governed surfaces.',
    code: 'DEFAULT_SETTINGS_INITIALIZATION_DISABLED',
  }, { status: 409 })
}
