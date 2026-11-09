export {}

async function main() {
  throw new Error(
    'Refusing direct recommendation generation: a governed current sync manifest is required.',
  )
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
