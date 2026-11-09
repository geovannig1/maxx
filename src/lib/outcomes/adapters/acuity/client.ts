import 'server-only'
// Acuity Scheduling API client (Premium/API unlocked 2026-07-17).
//
// HTTP Basic auth: username = ACUITY_USER_ID, password = ACUITY_API_KEY (numeric user id + key from
// Acuity → Integrations). Base https://acuityscheduling.com/api/v1. Read-only here; this app never
// creates/cancels appointments (owner does that in Acuity).
//
// Pagination note (verified live): GET /appointments has NO offset/page param — it filters by
// APPOINTMENT date via minDate/maxDate and caps results (default max=100). To page across history,
// callers window by appointment-date ranges (see scripts/backfill-acuity.ts). `showall=true` returns
// canceled + active together; the default excludes canceled.

const BASE = 'https://acuityscheduling.com/api/v1'

export class AcuityConfigError extends Error {}
export class AcuityApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/** One value inside an intake form on an appointment (this is where captured attribution lands). */
export interface AcuityFormValue {
  fieldID: number
  name: string
  value: string
}
export interface AcuityForm {
  id: number
  name: string
  values: AcuityFormValue[]
}

/** The subset of the Acuity appointment object the ledger consumes (superset kept in `raw`). */
export interface AcuityAppointmentRaw {
  id: number | string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  datetime?: string | null
  datetimeCreated?: string | null
  price?: string | number | null
  priceSold?: string | number | null
  amountPaid?: string | number | null
  paid?: string | null
  type?: string | null
  appointmentTypeID?: number | null
  category?: string | null
  calendarID?: number | null
  canceled?: boolean | null
  noShow?: boolean | null
  /** Origin (BY-ID fetches only; the list endpoint omits the key): null = client-booked (website),
   *  a staff email = admin-created. Drives the CAPI action_source gate (R4). */
  scheduledBy?: string | null
  forms?: AcuityForm[] | null
  [key: string]: unknown
}

export interface AcuityAppointmentType {
  id: number
  name: string
  price: string
  duration: number
  active: boolean
  category?: string
}

export function isAcuityConfigured(): boolean {
  return Boolean(process.env.ACUITY_USER_ID && process.env.ACUITY_API_KEY)
}

function authHeader(): string {
  const user = process.env.ACUITY_USER_ID
  const key = process.env.ACUITY_API_KEY
  if (!user || !key) {
    throw new AcuityConfigError('ACUITY_USER_ID / ACUITY_API_KEY not set')
  }
  return `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`
}

async function acuityFetch<T>(path: string, opts: { allow404?: boolean } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: authHeader() } })
  if (!res.ok) {
    if (opts.allow404 && res.status === 404) return null as T
    const body = await res.text().catch(() => '')
    throw new AcuityApiError(`Acuity ${res.status} on ${path}: ${body.slice(0, 200)}`, res.status)
  }
  return (await res.json()) as T
}

export interface GetAppointmentsParams {
  /** Filters by APPOINTMENT date (not creation date), YYYY-MM-DD. */
  minDate?: string
  maxDate?: string
  /** Only canceled appointments. Mutually distinct from `showall`. */
  canceled?: boolean
  /** Include canceled + active together (overrides the default active-only). */
  showall?: boolean
  /** Exact client email — used by CAPI enrichment to find the just-created booking. */
  email?: string
  appointmentTypeID?: number
  calendarID?: number
  max?: number
  direction?: 'ASC' | 'DESC'
}

/** GET /appointments with filters. Returns [] on empty. */
export async function getAppointments(params: GetAppointmentsParams = {}): Promise<AcuityAppointmentRaw[]> {
  const q = new URLSearchParams()
  if (params.minDate) q.set('minDate', params.minDate)
  if (params.maxDate) q.set('maxDate', params.maxDate)
  if (params.canceled) q.set('canceled', 'true')
  if (params.showall) q.set('showall', 'true')
  if (params.email) q.set('email', params.email)
  if (params.appointmentTypeID) q.set('appointmentTypeID', String(params.appointmentTypeID))
  if (params.calendarID) q.set('calendarID', String(params.calendarID))
  q.set('max', String(params.max ?? 1000))
  q.set('direction', params.direction ?? 'DESC')
  const rows = await acuityFetch<AcuityAppointmentRaw[]>(`/appointments?${q.toString()}`)
  return Array.isArray(rows) ? rows : []
}

export interface ExhaustiveAppointmentSweepResult {
  rows: AcuityAppointmentRaw[]
  complete: boolean
  blocker: 'single_appointment_day_at_cap' | 'appointment_window_limit_exhausted' | null
  queriedWindows: number
}

type AppointmentWindowFetcher = (
  minDate: string,
  maxDate: string,
) => Promise<AcuityAppointmentRaw[]>

const DAY_MS = 86_400_000

function splitDateWindow(minDate: string, maxDate: string): [string, string, string, string] | null {
  const minMs = Date.parse(`${minDate}T00:00:00Z`)
  const maxMs = Date.parse(`${maxDate}T00:00:00Z`)
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs >= maxMs) return null
  const leftEndMs = Math.floor(((minMs + maxMs) / 2) / DAY_MS) * DAY_MS
  const rightStartMs = leftEndMs + DAY_MS
  return [
    minDate,
    new Date(leftEndMs).toISOString().slice(0, 10),
    new Date(rightStartMs).toISOString().slice(0, 10),
    maxDate,
  ]
}

/**
 * Exhausts an appointment-date domain despite Acuity's non-pageable list endpoint. A window that
 * reaches the requested cap is divided into non-overlapping halves until every response is below
 * the cap. A cap reached on one day is unprovable and fails closed.
 */
export async function fetchAllAppointmentsByDateWindows(
  fetchWindow: AppointmentWindowFetcher,
  options: { minDate: string; maxDate: string; maxPerWindow: number; maxWindows: number },
): Promise<ExhaustiveAppointmentSweepResult> {
  const pending: Array<{ minDate: string; maxDate: string }> = [
    { minDate: options.minDate, maxDate: options.maxDate },
  ]
  const byId = new Map<string, AcuityAppointmentRaw>()
  let queriedWindows = 0

  while (pending.length > 0) {
    if (queriedWindows >= options.maxWindows) {
      return {
        rows: [...byId.values()], complete: false,
        blocker: 'appointment_window_limit_exhausted', queriedWindows,
      }
    }
    const window = pending.pop() as { minDate: string; maxDate: string }
    const rows = await fetchWindow(window.minDate, window.maxDate)
    queriedWindows += 1
    for (const row of rows) byId.set(String(row.id), row)
    if (rows.length < options.maxPerWindow) continue

    const split = splitDateWindow(window.minDate, window.maxDate)
    if (!split) {
      return {
        rows: [...byId.values()], complete: false,
        blocker: 'single_appointment_day_at_cap', queriedWindows,
      }
    }
    const [leftStart, leftEnd, rightStart, rightEnd] = split
    pending.push(
      { minDate: rightStart, maxDate: rightEnd },
      { minDate: leftStart, maxDate: leftEnd },
    )
  }

  return { rows: [...byId.values()], complete: true, blocker: null, queriedWindows }
}

/** GET /appointments/:id — full record incl. `forms`. Null on 404. */
export async function getAppointment(id: number | string): Promise<AcuityAppointmentRaw | null> {
  return acuityFetch<AcuityAppointmentRaw | null>(`/appointments/${encodeURIComponent(String(id))}`, { allow404: true })
}

export async function listAppointmentTypes(): Promise<AcuityAppointmentType[]> {
  const rows = await acuityFetch<AcuityAppointmentType[]>(`/appointment-types`)
  return Array.isArray(rows) ? rows : []
}
