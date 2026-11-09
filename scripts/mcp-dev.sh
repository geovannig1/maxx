#!/usr/bin/env bash
# Run the MCP server locally with the variables from .env.local (Node's own env-file loader, which
# handles quoted values and JSON correctly).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.local ] || { echo ".env.local not found; run: npm run setup" >&2; exit 1; }
echo "Starting Maxx MCP server (stdio)..." >&2
# tsconfig.mcp.json maps Next's `server-only` marker to its server no-op (see that file).
TSX_TSCONFIG_PATH=tsconfig.mcp.json exec node --env-file=.env.local --import tsx src/mcp/server.ts
