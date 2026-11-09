export {}

async function main() {
  const dates = process.argv.slice(2).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  if (dates.length === 0) {
    console.error('Usage: npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/regenerate-daily-reports.ts YYYY-MM-DD [YYYY-MM-DD ...]')
    process.exit(1)
  }
  throw new Error(
    `Refusing to regenerate ${dates.join(', ')} from warehouse rows. ` +
    'Daily V3 can only be committed by a complete synchronized evidence run; historical reports remain read-only.',
  )
}

main().catch((e) => { console.error(e); process.exit(1) })
