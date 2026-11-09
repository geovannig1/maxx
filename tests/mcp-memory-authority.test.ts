import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { READ_ONLY_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from '@/mcp/tools/index'

describe('MCP persistent-memory authority', () => {
  it('does not expose a model-writeable persistent-memory tool', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).not.toContain('store_agent_memory')
    expect(READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name)).not.toContain('store_agent_memory')

    const source = readFileSync(new URL('../src/mcp/tools/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/case ['"]store_agent_memory['"]:/)
    expect(source).not.toMatch(/import \{[^}]*storeAgentMemory/)
  })
})
