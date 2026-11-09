// `npm install` prints the next step and nothing else. It never prompts,
// never touches the network and can never fail an install: every path exits 0. Silent in CI and when
// the output is not a terminal (Vercel and other build systems set CI).

/** The message to print, or null for silence. Pure, for tests. */
export function postinstallMessage(env, isTTY) {
  if (env.CI || !isTTY) return null
  return [
    '',
    'Maxx is installed. Next:',
    '  npm run demo     try it on sample data, no accounts needed',
    '  npm run setup    connect Supabase, Meta and your outcome source',
    '  npm run doctor   check a configuration at any time',
    '',
  ].join('\n')
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  try {
    const message = postinstallMessage(process.env, process.stdout.isTTY === true)
    if (message) console.log(message)
  } catch {
    // Never fail an install over a message.
  }
  process.exitCode = 0
}
