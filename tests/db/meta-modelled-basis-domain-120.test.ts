import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { insertActionDecision } from './decision-fixture'

const ACCOUNT = fixtureUuid(120)
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

describe('Meta-modelled association basis domain', () => {
  it('admits the governed Meta-modelled basis without opening the domain', async () => {
    await expect(insertActionDecision(db, ACCOUNT, {
      evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association',
    })).resolves.toBeDefined()
    await expect(insertActionDecision(db, ACCOUNT, {
      evidence_plane: 'meta_modelled', evidence_basis: 'invented_basis',
    })).rejects.toThrow(/action_decisions_basis_domain/i)
  })
})
