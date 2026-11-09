import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// Docs smoke test helpers. Pure functions
// over markdown text plus a repository root, so the test can feed planted documents as controls.
//
// A shell command found in a fenced ```bash / ```sh / ```shell block is split the way a shell would
// split it (quotes, line continuations, comments, && || ; |), then classified:
//   repo      npm scripts, npx tsx, node, repository scripts: checked against package.json and the tree
//   external  needs a network service or an outside tool (git clone, curl, supabase, vercel, openssl…):
//             checked statically (app routes exist, the clone URL is this repository, env names exist)
//   shell     cd, assignments, printf/echo/date/awk: only their variable references are checked
// Anything else is a finding, so a new kind of command cannot slip in unclassified.

export const SHELL_LANGS: ReadonlySet<string> = new Set(['bash', 'sh', 'shell'])

export interface CodeBlock { file: string; line: number; lang: string; code: string }

export interface ShellCommand {
  file: string
  line: number
  text: string
  /** Leading `NAME=value` assignments (and `export NAME=value`). */
  assignments: string[]
  /** The command words after the assignments, quotes removed. */
  words: string[]
  /** `$NAME` / `${NAME}` references outside single quotes. */
  envRefs: string[]
  /** Every name assigned anywhere in the same block: shell locals, not configuration. */
  blockLocals: string[]
}

export type CommandKind = 'repo' | 'external' | 'shell'

export interface CommandResult { command: ShellCommand; kind: CommandKind | 'unclassified'; problems: string[] }

export interface SmokeContext {
  root: string
  packageScripts: Readonly<Record<string, string>>
  /** https URL of this repository (package.json `repository.url` without `.git`). */
  repositoryUrl: string
  envNames: ReadonlySet<string>
  /** Prefixes of development/test variables (SB_, E2E_, …) that the schema deliberately leaves out. */
  devPrefixes: readonly string[]
  /** First underscore-separated segment of every schema name: an UPPER_SNAKE token starting with one
   *  is read as a claim that such a variable exists. */
  envFirstSegments: ReadonlySet<string>
  /** Upper-snake strings the code uses as response codes, which are not variables. */
  knownCodes: ReadonlySet<string>
  /** Option checks for npm scripts whose arguments are validated statically; null means valid. */
  scriptArgs: Readonly<Record<string, (args: string[]) => string | null>>
}

export function extractCodeBlocks(markdown: string, file: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  const lines = markdown.split('\n')
  let open: { lang: string; line: number; body: string[] } | null = null
  lines.forEach((text, index) => {
    if (open === null) {
      const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(text)
      if (fence) open = { lang: fence[1].toLowerCase(), line: index + 1, body: [] }
      return
    }
    if (/^\s*```\s*$/.test(text)) {
      blocks.push({ file, line: open.line, lang: open.lang, code: open.body.join('\n') })
      open = null
      return
    }
    open.body.push(text)
  })
  return blocks
}

/** Shell-split one block into commands. Handles quotes, `\` continuations, `#` comments and `$(…)`. */
export function splitShell(block: CodeBlock): ShellCommand[] {
  const commands: ShellCommand[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  let depth = 0 // inside $( … )
  let text = ''
  let envRefs: string[] = []
  let line = block.line + 1
  let startLine = line
  const src = block.code

  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(toCommand(block.file, startLine, text.trim(), words, envRefs))
    words = []
    text = ''
    envRefs = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\n') line++
    if (words.length === 0 && !inWord && text.trim() === '') startLine = line
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
      text += ch
      continue
    }
    if (ch === '\\' && src[i + 1] === '\n') {
      i++
      line++
      text += ' '
      continue
    }
    if (ch === '$' && /[A-Za-z_{]/.test(src[i + 1] ?? '')) {
      const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i))
      if (ref) envRefs.push(ref[1])
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else word += ch
      text += ch
      continue
    }
    if (ch === '$' && src[i + 1] === '(') {
      depth++
      word += '$('
      inWord = true
      text += '$('
      i++
      continue
    }
    if (depth > 0) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      word += ch
      text += ch
      continue
    }
    if (ch === '#' && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
      text += ch
      continue
    }
    if (ch === '\n' || ch === ';') {
      endCommand()
      continue
    }
    if (ch === '&' && src[i + 1] === '&') { i++; endCommand(); continue }
    if (ch === '|') { if (src[i + 1] === '|') i++; endCommand(); continue }
    if (ch === ' ' || ch === '\t') {
      endWord()
      text += ch
      continue
    }
    word += ch
    inWord = true
    text += ch
  }
  endCommand()
  const blockLocals = commands.flatMap((c) => c.assignments)
  return commands.map((c) => ({ ...c, blockLocals }))
}

function toCommand(file: string, line: number, text: string, all: string[], envRefs: string[]): ShellCommand {
  const assignments: string[] = []
  let index = 0
  if (all[0] === 'export') index = 1
  while (index < all.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[index])) {
    assignments.push(all[index].slice(0, all[index].indexOf('=')))
    index++
  }
  return { file, line, text, assignments, words: all.slice(index), envRefs, blockLocals: [] }
}

const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

/** Null when `name` is a schema variable, a development variable, or not a variable-shaped claim. */
export function checkEnvName(name: string, ctx: SmokeContext): string | null {
  if (ctx.envNames.has(name)) return null
  if (ctx.devPrefixes.some((prefix) => name.startsWith(prefix))) return null
  if (ctx.knownCodes.has(name)) return null
  if (!UPPER_SNAKE.test(name)) return null
  if (!ctx.envFirstSegments.has(name.split('_')[0])) return null
  return `\`${name}\` is not a variable in src/config/env.ts`
}

// `set -a; . ./.env.local; set +a` loads the env file for a one-off command; `read -rs` takes a secret unechoed.
const SHELL_TOOLS = new Set(['cd', 'printf', 'echo', 'date', 'awk', 'sed', 'cat', 'export', 'true', 'set', '.', 'read'])
const EXTERNAL_TOOLS = new Set(['curl', 'supabase', 'vercel', 'openssl', 'python3', 'docker', 'gitleaks', 'pg_dump'])
const NPM_BUILTINS = new Set(['ci', 'install', 'audit', 'ls'])
const REPO_DIRS = ['scripts/', 'src/', 'docs/', 'supabase/', 'tests/', 'config/', '.github/']
/** Hosts the docs use for "your Maxx deployment"; paths on them must be real routes. */
export const APP_ORIGINS = ['https://maxx.example.com', 'http://localhost:3000', 'http://127.0.0.1:3000']

function looksLikeRepoPath(token: string): boolean {
  const bare = token.replace(/^\.\//, '')
  return REPO_DIRS.some((dir) => bare.startsWith(dir)) && !/[*{}<>$]/.test(bare)
}

function repoPathProblem(token: string, root: string): string | null {
  const bare = token.replace(/^\.\//, '').replace(/[),.:;]+$/, '')
  return existsSync(path.join(root, bare)) ? null : `\`${bare}\` does not exist`
}

export function validateCommand(command: ShellCommand, ctx: SmokeContext): CommandResult {
  const problems: string[] = []
  const locals = new Set([...command.assignments, ...command.blockLocals])
  for (const name of command.assignments) {
    const problem = checkEnvName(name, ctx)
    // An assignment of a Maxx-shaped name must be a real variable; any other name is a local.
    if (problem) problems.push(problem)
  }
  for (const ref of command.envRefs) {
    if (locals.has(ref)) continue
    const problem = checkEnvName(ref, ctx)
    if (problem) problems.push(problem)
  }
  const [head, ...args] = command.words
  for (const arg of args) {
    if (looksLikeRepoPath(arg)) {
      const problem = repoPathProblem(arg, ctx.root)
      if (problem) problems.push(problem)
    }
  }
  if (head === undefined) return { command, kind: 'shell', problems }

  if (head === 'npm') return { command, kind: 'repo', problems: [...problems, ...npmProblems(args, ctx)] }
  if (head === 'npx') return { command, kind: 'repo', problems: [...problems, ...npxProblems(args, ctx)] }
  if (head === 'node' || head === 'bash') {
    const target = args.find((a) => !a.startsWith('-'))
    if (!target) problems.push(`\`${head}\` without a file`)
    else if (!looksLikeRepoPath(target)) problems.push(`\`${head} ${target}\` does not run a repository file`)
    return { command, kind: 'repo', problems }
  }
  if (looksLikeRepoPath(head)) {
    const problem = repoPathProblem(head, ctx.root)
    if (problem) problems.push(problem)
    else if ((statSync(path.join(ctx.root, head.replace(/^\.\//, ''))).mode & 0o111) === 0) problems.push(`\`${head}\` is not executable`)
    return { command, kind: 'repo', problems }
  }
  if (head === 'git') {
    if (args[0] === 'clone') {
      const url = args.find((a) => /^https?:\/\//.test(a))
      if (!url || url.replace(/\.git$/, '') !== ctx.repositoryUrl) problems.push(`clone URL is not ${ctx.repositoryUrl}`)
    }
    return { command, kind: 'external', problems }
  }
  if (EXTERNAL_TOOLS.has(head)) {
    for (const arg of args) {
      const origin = APP_ORIGINS.find((o) => arg.startsWith(o))
      if (origin) {
        const route = arg.slice(origin.length).split(/[?#]/)[0] || '/'
        if (!appRouteExists(ctx.root, route)) problems.push(`no app route serves \`${route}\``)
      }
    }
    return { command, kind: 'external', problems }
  }
  if (SHELL_TOOLS.has(head)) return { command, kind: 'shell', problems }
  return { command, kind: 'unclassified', problems: [...problems, `unclassified command \`${head}\``] }
}

function npmProblems(args: string[], ctx: SmokeContext): string[] {
  const [sub, ...rest] = args
  if (sub === 'test') return 'test' in ctx.packageScripts ? [] : ['package.json has no `test` script']
  if (sub && NPM_BUILTINS.has(sub)) return []
  if (sub !== 'run' || !rest[0]) return [`unsupported npm command \`npm ${args.join(' ')}\``]
  const script = rest[0]
  if (!(script in ctx.packageScripts)) return [`package.json has no \`${script}\` script`]
  const sep = rest.indexOf('--')
  const scriptArgs = sep >= 0 ? rest.slice(sep + 1) : []
  if (sep < 0 && rest.length > 1) return [`arguments to \`npm run ${script}\` need \`--\``]
  const check = ctx.scriptArgs[script]
  if (scriptArgs.length > 0 && !check) return [`\`npm run ${script}\` takes no documented options`]
  const problem = check ? check(scriptArgs) : null
  return problem ? [problem] : []
}

/** The Supabase CLI at the version scripts/sb.sh pins (tests/supabase-cli-pin.test.ts keeps them equal). */
const PINNED_SUPABASE = /^supabase@\d+\.\d+\.\d+$/

function npxProblems(args: string[], ctx: SmokeContext): string[] {
  const tool = args.filter((a) => a !== '--yes')
  if (PINNED_SUPABASE.test(tool[0] ?? '')) return tool.length > 1 ? [] : ['`npx supabase@<pin>` without a CLI command']
  if (args[0] !== 'tsx') return [`unsupported npx command \`npx ${args.join(' ')}\``]
  const problems: string[] = []
  const tsconfigAt = args.indexOf('--tsconfig')
  if (tsconfigAt < 0) problems.push('`npx tsx` without `--tsconfig` (server-only modules need tsconfig.scripts.json)')
  else if (!existsSync(path.join(ctx.root, args[tsconfigAt + 1] ?? ''))) problems.push(`\`${args[tsconfigAt + 1]}\` does not exist`)
  const script = args.slice(1).find((a, i, all) => !a.startsWith('-') && all[i - 1] !== '--tsconfig')
  if (!script || !looksLikeRepoPath(script)) problems.push('`npx tsx` does not run a repository script')
  return problems
}

/** Whether a URL path is served by src/app (route groups ignored, [x] and [...x] segments match). */
/** A trailing `*` (`/api/cron/*`) asks only that some route exists below the prefix. */
export function appRouteExists(root: string, urlPath: string): boolean {
  const prefix = urlPath.endsWith('*')
  const segments = urlPath.replace(/\*$/, '').split('/').filter(Boolean)
  return matchDir(path.join(root, 'src/app'), segments, prefix)
}

function matchDir(dir: string, segments: string[], prefix = false): boolean {
  if (!existsSync(dir)) return false
  const entries = readdirSync(dir, { withFileTypes: true })
  if (segments.length === 0) {
    if (prefix) return true
    if (entries.some((e) => e.isFile() && /^(page|route)\.(tsx?|jsx?)$/.test(e.name))) return true
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const sub = path.join(dir, name)
    if (/^\(.*\)$/.test(name) && matchDir(sub, segments, prefix)) return true
    if (segments.length === 0) continue
    if (/^\[\.\.\..+\]$/.test(name) && matchDir(sub, [])) return true
    const head = segments[0]
    const placeholder = /^<.+>$/.test(head)
    if ((name === head && !placeholder) || (/^\[[^.].*\]$/.test(name)) ) {
      if (matchDir(sub, segments.slice(1), prefix)) return true
    }
  }
  return false
}

/** Problems in a markdown document's prose: env names, relative links, repository paths, API routes. */
export function proseProblems(markdown: string, file: string, ctx: SmokeContext): string[] {
  const problems: string[] = []
  const withoutUrls = markdown.replace(/https?:\/\/\S+/g, ' ')
  for (const match of withoutUrls.matchAll(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(_?\*)?(?![A-Za-z0-9_])/g)) {
    const name = match[0].replace(/_?\*$/, '')
    if (match[1]) {
      const prefix = `${name}_`
      const known = [...ctx.envNames].some((n) => n.startsWith(prefix)) || ctx.devPrefixes.some((p) => p.startsWith(prefix) || prefix.startsWith(p))
      if (!known && ctx.envFirstSegments.has(name.split('_')[0])) problems.push(`${file}: \`${name}_*\` matches no variable`)
      continue
    }
    const problem = checkEnvName(name, ctx)
    if (problem) problems.push(`${file}: ${problem}`)
  }
  for (const link of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = link[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const bare = decodeURIComponent(target.split('#')[0])
    if (!existsSync(path.resolve(ctx.root, path.dirname(file), bare))) problems.push(`${file}: link target \`${target}\` does not exist`)
  }
  for (const span of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = span[1].trim()
    if (looksLikeRepoPath(token) && !/\s/.test(token)) {
      const problem = repoPathProblem(token, ctx.root)
      if (problem) problems.push(`${file}: ${problem}`)
    }
    const bare = token.split(/[?#]/)[0]
    const onApp = /^https?:\/\/(?:<your-domain>|<your-app>|maxx\.example\.com|localhost:3000|127\.0\.0\.1:3000)(\/\S*)$/.exec(bare)
    const api = onApp ?? /^(?:(?:GET|POST|PATCH|PUT|DELETE)\s+)?(\/api(?:\/[^\s`]*)?)$/.exec(bare)
    // `/**` is Supabase's redirect allow-list wildcard (every path), not a route.
    if (api && api[1] !== '/**' && !appRouteExists(ctx.root, api[1])) problems.push(`${file}: no app route serves \`${api[1]}\``)
  }
  return problems
}

/** Markdown files under `dir` (not recursive). */
export function markdownIn(root: string, dir: string): string[] {
  return readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith('.md'))
    .map((name) => (dir === '.' ? name : `${dir}/${name}`))
    .sort()
}
