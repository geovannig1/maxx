import { describe, expect, it } from 'vitest'
import { buildExecutiveEvidenceSnapshotV1 } from '@/lib/report/executive-evidence'
import {
  commitExecutiveEvidenceGeneration,
  readExecutiveEvidenceGeneration,
} from '@/lib/report/executive-evidence-store'

const ACCOUNT = '00000000-0000-4000-8000-000000001091'

async function snapshot() {
  return buildExecutiveEvidenceSnapshotV1({
    accountId: ACCOUNT,
    accountName: 'Studio',
    timezone: 'America/New_York',
    asOf: '2026-08-16T14:00:00.000Z',
    lastCompleteDate: '2026-08-15',
  }, {})
}

function fakeDb(error: { message: string } | null = null) {
  const inserted: Record<string, unknown>[] = []
  const db = {
    from(table: string) {
      expect(table).toBe('executive_evidence_generations')
      return {
        insert(payload: Record<string, unknown>) {
          inserted.push(payload)
          return {
            select() {
              return {
                single: async () => ({
                  data: error ? null : { id: '00000000-0000-4000-8000-000000001099' },
                  error,
                }),
              }
            },
          }
        },
      }
    },
  }
  return { db, inserted }
}

describe('executive evidence generation store', () => {
  it('commits the exact diagnostic snapshot with a deterministic fingerprint', async () => {
    const first = fakeDb()
    const second = fakeDb()
    const evidence = await snapshot()

    const a = await commitExecutiveEvidenceGeneration(first.db as never, evidence)
    const b = await commitExecutiveEvidenceGeneration(second.db as never, {
      ...evidence,
      account: { timezone: evidence.account.timezone, name: evidence.account.name, id: evidence.account.id },
    })

    expect(a).toEqual({
      id: '00000000-0000-4000-8000-000000001099',
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(b.fingerprint).toBe(a.fingerprint)
    expect(first.inserted[0]).toMatchObject({
      ad_account_id: ACCOUNT,
      report_date: '2026-08-15',
      contract_version: 1,
      evidence_json: evidence,
      source_generated_at: evidence.generatedAt,
      evidence_fingerprint: a.fingerprint,
    })
  })

  it('rejects any snapshot that can authorize money or lacks account/date identity', async () => {
    const evidence = await snapshot()
    await expect(commitExecutiveEvidenceGeneration(fakeDb().db as never, {
      ...evidence,
      authority: { ...evidence.authority, moneyActionsAuthorized: true as false },
    })).rejects.toThrow(/diagnostic-only/i)
    await expect(commitExecutiveEvidenceGeneration(fakeDb().db as never, {
      ...evidence,
      account: { ...evidence.account, id: '' },
    })).rejects.toThrow(/account/i)
  })

  it('fails closed when the immutable insert fails', async () => {
    await expect(commitExecutiveEvidenceGeneration(
      fakeDb({ message: 'warehouse unavailable' }).db as never,
      await snapshot(),
    )).rejects.toThrow(/warehouse unavailable/)
  })

  it('reads only the exact account/date generation and rejects mismatched evidence identity', async () => {
    const evidence = await snapshot()
    const exactDb = {
      from: () => ({
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({
              data: { id: '00000000-0000-4000-8000-000000001099', evidence_json: evidence },
              error: null,
            }),
          }
          return chain
        },
      }),
    }
    await expect(readExecutiveEvidenceGeneration(exactDb as never, {
      id: '00000000-0000-4000-8000-000000001099',
      accountId: ACCOUNT,
      reportDate: '2026-08-15',
    })).resolves.toEqual(evidence)

    const mismatchedDb = {
      from: () => ({
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({
              data: { id: '00000000-0000-4000-8000-000000001099', evidence_json: {
                ...evidence,
                lastCompleteDate: '2026-08-14',
              } },
              error: null,
            }),
          }
          return chain
        },
      }),
    }
    await expect(readExecutiveEvidenceGeneration(mismatchedDb as never, {
      id: '00000000-0000-4000-8000-000000001099',
      accountId: ACCOUNT,
      reportDate: '2026-08-15',
    })).rejects.toThrow(/identity/i)
  })
})
