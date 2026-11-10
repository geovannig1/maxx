#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md: every production dependency in package-lock.json with its license,
// plus the attribution notices Apache-2.0 asks redistributors to keep. Offline: it reads only
// package-lock.json and node_modules. Run `npm run notices` after changing dependencies;
// `npm run notices:check` (part of `npm run release:check`) fails while the file is out of date. The check
// is release-time, not part of `npm test`, so routine dependency PRs are not failed by it.
//
// Production = a lockfile package that npm does not mark `dev` or `devOptional` (the set
// `npm ci --omit=dev` can install). The license is the lockfile's; when the package is installed, its
// package.json must state the same license, or generation stops (a disagreement needs a person).
// Platform-specific optional packages that are not installed on this machine keep the lockfile's
// license, so the output is the same on every platform.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md'

/** The Anthropic SDK family: Apache-2.0 since 1.0.0, earlier versions MIT (their LICENSE-MIT says so). */
const ANTHROPIC_SCOPE = '@anthropic-ai/'

/** Licenses that are not plain permissive (MIT/BSD/ISC/Apache-style) and deserve a reader's attention. */
const ATTENTION = /LGPL|GPL|FSL|CC-BY|BUSL|SSPL|Unlicense|MPL|EPL/i

export function licenseText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type
  if (Array.isArray(value)) return value.map(licenseText).join(' OR ')
  return 'UNKNOWN'
}

function nameFromKey(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

/**
 * @param {{ lock: { packages: Record<string, any> }, readInstalled: (dir: string) => null | { manifest: any, files: string[], read: (file: string) => string } }} input
 */
export function collectProductionPackages({ lock, readInstalled }) {
  const byId = new Map()
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.link) continue
    const name = nameFromKey(key)
    const license = licenseText(entry.license)
    const installed = readInstalled(key)
    if (installed) {
      const declared = licenseText(installed.manifest.license ?? installed.manifest.licenses)
      if (declared !== license) {
        throw new Error(`${name}@${entry.version}: package-lock.json says ${license}, its package.json says ${declared}`)
      }
    }
    const id = `${name}@${entry.version}`
    if (byId.has(id)) continue
    const notice = !entry.optional && installed
      ? installed.files.filter((f) => /^NOTICE(\.(md|txt))?$/i.test(f)).map((f) => installed.read(f).trim())
      : []
    const copyright = name.startsWith(ANTHROPIC_SCOPE) && installed && installed.files.includes('LICENSE')
      ? ([...installed.read('LICENSE').matchAll(/^\s*Copyright (?!\[).+$/gm)].at(-1)?.[0].trim() ?? null)
      : null
    byId.set(id, { name, version: entry.version, license, optional: Boolean(entry.optional), notice, copyright })
  }
  return [...byId.values()].sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)))
}

export function renderNotices(packages) {
  const counts = new Map()
  for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1)
  const anthropic = packages.filter((p) => p.name.startsWith(ANTHROPIC_SCOPE))
  const attention = packages.filter((p) => ATTENTION.test(p.license))
  const withNotice = packages.filter((p) => p.notice.length > 0)
  const cell = (s) => s.replace(/\|/g, '\\|')
  const lines = [
    '# Third-party notices',
    '',
    '<!-- Generated from package-lock.json and node_modules by `npm run notices`. Do not edit by hand. -->',
    '',
    'Maxx is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). It depends on the',
    'third-party packages below, each under its own license. This list covers production dependencies:',
    'packages in `package-lock.json` that npm does not mark as development-only. Platform-specific',
    'optional packages are listed even though only the one matching your system is installed.',
    '',
    'Files vendored into the repository are listed in the README: `docs/meta-knowledge/` (MIT) and',
    '`src/app/vendor/shadcn-tailwind.css` (MIT).',
    '',
    `${packages.length} packages. Licenses:`,
    '',
    '| License | Packages |',
    '|---|---:|',
    ...[...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, n]) => `| ${cell(l)} | ${n} |`),
    '',
    '## Anthropic SDK family (Apache-2.0)',
    '',
    'Maxx calls Claude through the Anthropic SDK family. These versions are licensed under the Apache',
    'License, Version 2.0. Earlier versions were published under the MIT License, as each package\'s',
    '`LICENSE-MIT` file records.',
    '',
    ...anthropic.flatMap((p) => [
      `- \`${p.name}\` ${p.version}: ${p.license}. ${p.copyright ?? 'Copyright Anthropic, PBC.'}`,
    ]),
    '',
    '```',
    'Licensed under the Apache License, Version 2.0 (the "License");',
    'you may not use this file except in compliance with the License.',
    'You may obtain a copy of the License at',
    '',
    '    http://www.apache.org/licenses/LICENSE-2.0',
    '',
    'Unless required by applicable law or agreed to in writing, software',
    'distributed under the License is distributed on an "AS IS" BASIS,',
    'WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.',
    'See the License for the specific language governing permissions and',
    'limitations under the License.',
    '```',
    '',
  ]
  if (withNotice.length > 0) {
    lines.push('## NOTICE files', '', 'Reproduced as Apache-2.0 section 4(d) requires.', '')
    for (const p of withNotice) {
      lines.push(`### ${p.name} ${p.version}`, '', '```', ...p.notice.flatMap((n) => n.split('\n').map((l) => l.trimEnd())), '```', '')
    }
  }
  lines.push(
    '## Licenses that need attention',
    '',
    'Not plain permissive licenses. Read each before redistributing a build.',
    '',
    '| Package | Version | License | Note |',
    '|---|---|---|---|',
    ...attention.map((p) => `| \`${p.name}\` | ${p.version} | ${cell(p.license)} | ${p.optional ? 'optional, platform-specific' : ''} |`),
    '',
    '## All production dependencies',
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...packages.map((p) => `| \`${p.name}\` | ${p.version} | ${cell(p.license)}${p.optional ? ' (optional)' : ''} |`),
    '',
  )
  return lines.join('\n')
}

export function readInstalledFrom(root) {
  return (dir) => {
    const full = path.join(root, dir)
    const manifest = path.join(full, 'package.json')
    if (!existsSync(manifest)) return null
    return {
      manifest: JSON.parse(readFileSync(manifest, 'utf8')),
      files: readdirSync(full),
      read: (file) => readFileSync(path.join(full, file), 'utf8'),
    }
  }
}

export function generateNotices(root) {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  return renderNotices(collectProductionPackages({ lock, readInstalled: readInstalledFrom(root) }))
}

/** true when the committed notices file equals a fresh generation for `root`. */
export function noticesAreCurrent(root) {
  const file = path.join(root, NOTICES_FILE)
  return existsSync(file) && readFileSync(file, 'utf8') === generateNotices(root)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (process.argv.includes('--check')) {
    if (!noticesAreCurrent(root)) {
      console.error(`${NOTICES_FILE} is out of date: run npm run notices`)
      process.exit(1)
    }
    console.log(`${NOTICES_FILE} is current`)
  } else {
    writeFileSync(path.join(root, NOTICES_FILE), generateNotices(root))
    console.log(`wrote ${NOTICES_FILE}`)
  }
}
