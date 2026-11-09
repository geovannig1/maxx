/** What an owner sees when a server dependency fails. The detail goes to the server log only. */
export const API_ERROR_MESSAGE = 'The request could not be completed. The details were logged on the server.'

function errorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

/**
 * Database and provider error text (table, column, constraint, SQL state, upstream response) must not
 * reach the browser. Logs the detail with the route name and returns a generic message plus a stable
 * code, keeping the caller's status and any extra response fields the client already relies on.
 */
export function apiErrorResponse(
  route: string,
  code: string,
  error: unknown,
  status = 500,
  extra: Record<string, unknown> = {},
): Response {
  console.error(`[api ${route}] ${code}:`, errorDetail(error))
  return Response.json({ ...extra, error: API_ERROR_MESSAGE, code }, { status })
}

/** What a model sees in an MCP tool result when a data dependency fails. The detail goes to stderr. */
export const TOOL_ERROR_MESSAGE = 'The data could not be read. The details were logged on the server.'

/**
 * MCP tool results are read by a model and can be relayed to a person, so database and provider text
 * stays out of them as well. Logs the detail to stderr (console.error; stdout carries the stdio
 * protocol) and returns the generic message for the result's reason field; the caller keeps its code.
 */
export function logToolError(tool: string, code: string, error: unknown): string {
  console.error(`[mcp ${tool}] ${code}:`, errorDetail(error))
  return TOOL_ERROR_MESSAGE
}

/**
 * A tool-argument problem whose message is authored by the tool itself (never database or provider
 * text), so the dispatcher may return it and the model can correct its call.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}
