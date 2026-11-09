import 'server-only'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ensureMcpEnv, isPlaceholder } from './env'
import { registerTools } from './tools/index'
import { MAXX_INSTRUCTIONS } from './instructions'

// Hydrate missing/placeholder env from .env.local FIRST — a standalone tsx process doesn't get
// Next.js's automatic env loading, and MCP registrations can pass literal "${VAR}" placeholders.
ensureMcpEnv()

// Validate required env vars at startup. isPlaceholder catches unexpanded "${VAR}" strings that
// would pass a plain existence check and then fail at Supabase client creation.
const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
for (const key of REQUIRED_ENV) {
  if (isPlaceholder(process.env[key])) {
    console.error(`[MCP] Missing or unexpanded environment variable: ${key} — set it in the MCP registration or .env.local`)
    process.exit(1)
  }
}


const server = new Server(
  {
    name: 'maxx',
    version: '1.0.0',
  },
  {
    capabilities: { tools: {} },
    instructions: MAXX_INSTRUCTIONS,
  }
)

registerTools(server)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[MCP] Maxx MCP server running on stdio')
}

main().catch((error) => {
  console.error('[MCP] Fatal error:', error)
  process.exit(1)
})
