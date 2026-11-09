import { createClient } from '@/lib/supabase/server'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { runMaxxChat, maxxChatEnabled } from '@/lib/maxx/chat'
import { aiStatus } from '@/lib/ai'
import { ownerOnly } from '@/lib/auth/require-owner'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'
export const maxDuration = 60

const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' }

function privateJson(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...PRIVATE_NO_STORE, ...init?.headers },
  })
}

// POST /api/maxx/chat — the in-app Maxx assistant. Auth-gated and stateless (the client replays the short
// history each turn). It exposes no write tool. For the signed-in owner it can run three actions
// (ADR-062: copy variants, a plan DRAFT, a PENDING proposal); none approves, applies or touches Meta.
/**
 * A USER message is typed; a governed ANSWER is rendered, and the two have nothing in common.
 *
 * Both used to share `max(6000)`. `MaxxChat` replays the whole transcript on every turn, so an
 * assistant turn longer than the cap made the NEXT question fail `400 Invalid request` — the good
 * answer rendered, and the conversation died with a generic red banner and no diagnosis.
 *
 * It was unreachable before per-metric trends: 14 governed claims rendered to at most ~4,247 chars.
 * At 49 claims a brief citing 22 crosses 6,000, and the answer contract explicitly asks the model to
 * "cite every claim that bears on the question, including the unavailable ones". So a later change turned a
 * structural impossibility into an ordinary outcome — the same defect as the 60,000-char tool-result
 * cap, on the other side of the loop.
 *
 * The server composes assistant text and bounds it itself; the cap here exists to stop an oversized
 * REPLAY, not to police content the server wrote. `tests/maxx-chat-message-bound.test.ts` pins the
 * relationship to what a full cockpit can actually render.
 */
const MAX_USER_MESSAGE_CHARS = 6_000
const MAX_ASSISTANT_MESSAGE_CHARS = 24_000

/**
 * The whole replayed transcript, which is what actually gates the request.
 *
 * Raising the per-message assistant bound to 24,000 fixed nothing on its own: `MaxxChat` replays
 * every turn, so at a measured 14,511 chars for a full governed answer the third request reaches
 * ~29,200 chars and the FOURTH fails 413 `CHAT_HISTORY_TOO_LARGE` — the same generic red banner,
 * two turns later. The per-message bound was unreachable a second time in any conversation.
 *
 * DERIVED from the message bounds so the two cannot drift apart again: five governed answers and
 * five questions. Beyond that the client should start a new conversation, which is what the schema's
 * 20-message cap already implies.
 *
 * This is a real token cost — a long conversation now carries more context per turn — and it is
 * bounded deliberately rather than by a number nobody revisited.
 */
const MAX_CHAT_HISTORY_CHARS = (MAX_ASSISTANT_MESSAGE_CHARS + MAX_USER_MESSAGE_CHARS) * 5

const bodySchema = z.object({
  messages: z
    .array(
      z.union([
        z.object({
          role: z.literal('user'),
          content: z.string().min(1).max(MAX_USER_MESSAGE_CHARS),
        }).strict(),
        z.object({
          role: z.literal('assistant'),
          content: z.string().min(1).max(MAX_ASSISTANT_MESSAGE_CHARS),
        }).strict(),
      ]),
    )
    .min(1)
    .max(20),
}).strict()

export const MAXX_CHAT_MESSAGE_BOUNDS = {
  user: MAX_USER_MESSAGE_CHARS,
  assistant: MAX_ASSISTANT_MESSAGE_CHARS,
  history: MAX_CHAT_HISTORY_CHARS,
} as const

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return privateJson({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  // Cost guard: never call the metered API when the chat is disabled — even if the endpoint is hit.
  // `maxxChatEnabled` is the kill switch AND a configured AI provider; say which one is missing.
  if (!maxxChatEnabled()) {
    const ai = aiStatus()
    if (ai.state === 'off') {
      return privateJson({ error: 'AI is off, so Maxx chat is unavailable. Every other page works without AI.', disabled: true, code: 'AI_OFF' }, { status: 403 })
    }
    if (ai.state === 'misconfigured') {
      return privateJson({ error: 'The AI provider is not configured correctly, so Maxx chat is unavailable.', disabled: true, code: 'AI_MISCONFIGURED' }, { status: 403 })
    }
    return privateJson({ error: 'Maxx chat is turned off.', disabled: true }, { status: 403 })
  }

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return privateJson({ error: 'Invalid request' }, { status: 400 })
  }
  const historyChars = body.messages.reduce((total, message) => total + message.content.length, 0)
  if (historyChars > MAX_CHAT_HISTORY_CHARS) {
    return privateJson(
      { error: 'Chat history is too large.', code: 'CHAT_HISTORY_TOO_LARGE' },
      { status: 413 },
    )
  }
  if (body.messages[body.messages.length - 1].role !== 'user') {
    return privateJson({ error: 'Last message must be from the user' }, { status: 400 })
  }

  const limited = await enforceApiRateLimit({
    bucket: 'maxx_chat', actorKey: user.id, limit: 10, windowSeconds: 600,
  })
  if (limited) return limited

  try {
    const result = await runMaxxChat(body.messages, { ownerUserId: user.id })
    // A WITHHELD answer is a governed result, not a transport failure, and it is the only place the
    // system explains ITSELF: which lookup failed, which plane had no claim supply, why an answer
    // could not be verified. `runMaxxChat` composes nine distinct refusal strings and passes each
    // through `governMaxxAnswer` — the same sanitiser a successful answer goes through.
    //
    // This branch used to discard `result.text` and return a bare 503, so every one of those strings
    // was dead on the product surface: `MaxxChat.tsx` throws on `!res.ok` and paints one generic red
    // banner. The refusals were observable ONLY by calling `runMaxxChat` directly from a script,
    // which is exactly how they came to be believed working. Returning the composed text is what
    // makes every other honesty fix in this area verifiable in a browser instead of in a probe.
    //
    // 200, not 503: the request succeeded and produced a governed answer whose content is "I cannot
    // verify this". `availability` carries the state; the client renders it as a withheld assistant
    // turn rather than an error. The `catch` below keeps its 503 — a thrown provider or tool error
    // has no composed text and must not leak its detail.
    if (result.availability === 'unavailable') {
      return privateJson({ ...result, code: 'MAXX_CHAT_UNAVAILABLE' })
    }
    return privateJson(result)
  } catch {
    return privateJson({
      error: 'Maxx could not verify an answer from governed sources.',
      code: 'MAXX_CHAT_UNAVAILABLE',
      availability: 'unavailable',
    }, { status: 503 })
  }
}
