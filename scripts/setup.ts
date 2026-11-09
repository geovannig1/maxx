/**
 * Maxx first-run setup. Interactive, re-runnable, and safe to repeat.
 *
 *   npm run setup                        # asks for what is needed, validates it, writes .env.local
 *   npm run setup -- --apply-schema      # also applies the schema (SUPABASE_DB_URL, never saved)
 *   npm run setup -- --local             # starts a local Supabase stack (Docker) and writes its URL and keys
 *   CI=1 npm run setup                   # silent: takes the values from the environment
 *
 * Writes .env.local (or MAXX_ENV_FILE) with mode 600. Never prints a secret. See scripts/lib/setup-flow.ts.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { nodeEnvFileStore } from './lib/env-file'
import { runSetup } from './lib/setup-flow'
import type { RunCommand } from './lib/setup-steps'

/** A line from the terminal; secret answers are not echoed. */
function prompt(question: string, options: { secret: boolean }): Promise<string> {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (options.secret) {
      const writer = rl as unknown as { _writeToOutput: (text: string) => void }
      writer._writeToOutput = (text: string) => { if (text.includes(question)) process.stdout.write(question) }
    }
    rl.question(question, (answer) => {
      if (options.secret) process.stdout.write('\n')
      rl.close()
      done(answer)
    })
  })
}

async function main(): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !process.env.CI
  const runCommand: RunCommand = (command, args, options) => new Promise<{ code: number; stdout?: string }>((done, fail) => {
    // options.env carries values (the database password) that must not appear in the arguments.
    const env = options?.env ? { ...process.env, ...options.env } : process.env
    // A captured output (the local stack's keys) is returned to the caller and never shown.
    const stdout = options?.capture ? 'pipe' : interactive ? 'inherit' : 'ignore'
    const child = spawn(command, args, { stdio: [interactive && !options?.capture ? 'inherit' : 'ignore', stdout, 'inherit'], env })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', fail)
    child.on('close', (code) => done({ code: code ?? 1, ...(options?.capture ? { stdout: Buffer.concat(chunks).toString('utf8') } : {}) }))
  })
  const { liveAiProbe } = await import('../src/lib/setup/ai-probe')
  return runSetup(process.argv.slice(2), {
    envFilePath: resolve(process.cwd(), process.env.MAXX_ENV_FILE || '.env.local'),
    env: process.env,
    store: nodeEnvFileStore(),
    interactive,
    prompt,
    fetch,
    runCommand,
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    nodeVersion: process.versions.node,
    aiProbe: liveAiProbe,
  })
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
