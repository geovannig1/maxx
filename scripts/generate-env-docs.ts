/**
 * Regenerates docs/configuration.md and config/env.example.template from src/config/env.ts.
 *
 *   npm run env:docs            # write both files
 *   npm run env:docs -- --check # exit 1 when either is out of date (CI)
 *
 * It never writes a dotfile: config/env.example.template is reviewed, then copied to .env.example.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONFIGURATION_DOC, ENV_TEMPLATE, renderConfigurationDoc, renderEnvTemplate } from './lib/env-docs'

const outputs: Array<[string, string]> = [[CONFIGURATION_DOC, renderConfigurationDoc()], [ENV_TEMPLATE, renderEnvTemplate()]]
const check = process.argv.includes('--check')
let stale = 0
for (const [file, content] of outputs) {
  const path = resolve(process.cwd(), file)
  let current = ''
  try { current = readFileSync(path, 'utf8') } catch { current = '' }
  if (current === content) continue
  if (check) { console.error(`${file} is out of date: run npm run env:docs`); stale++ }
  else { writeFileSync(path, content); console.log(`wrote ${file}`) }
}
process.exit(stale > 0 ? 1 : 0)
