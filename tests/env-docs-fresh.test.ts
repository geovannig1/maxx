import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ENV_VARS } from '@/config/env'
import { CONFIGURATION_DOC, ENV_TEMPLATE, renderConfigurationDoc, renderEnvTemplate } from '../scripts/lib/env-docs'

// docs/configuration.md and config/env.example.template are generated from the schema. A schema change
// without `npm run env:docs` must fail here, so the documentation cannot drift from what is validated.

const ROOT = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

describe('generated configuration documents', () => {
  it('docs/configuration.md matches the schema', () => {
    expect(read(CONFIGURATION_DOC), 'run npm run env:docs').toBe(renderConfigurationDoc())
  })

  it('config/env.example.template matches the schema', () => {
    expect(read(ENV_TEMPLATE), 'run npm run env:docs').toBe(renderEnvTemplate())
  })

  it('control: a changed description changes the rendered document', () => {
    const before = renderConfigurationDoc()
    const spec = ENV_VARS.find((s) => s.name === 'OWNER_EMAIL')!
    const original = spec.description
    try {
      spec.description = `${original} (planted)`
      expect(renderConfigurationDoc()).not.toBe(before)
    } finally {
      spec.description = original
    }
  })

  it('documents every variable, and the template carries no value for any secret', () => {
    const doc = renderConfigurationDoc()
    for (const spec of ENV_VARS) expect(doc, spec.name).toContain(`\`${spec.name}\``)
    const template = renderEnvTemplate()
    for (const spec of ENV_VARS.filter((s) => s.secret && s.scope !== 'platform')) {
      expect(template, spec.name).toMatch(new RegExp(`^(# )?${spec.name}=$`, 'm'))
    }
  })
})
