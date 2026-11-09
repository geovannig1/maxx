import { z } from 'zod'
import type { GoldenQuestion } from './golden-questions'

const pinnedQuestionFixtureSchema = z.object({
  fixture_version: z.literal(2),
  owner_question: z.object({
    id: z.string().trim().min(1),
    prompt: z.string().trim().min(1).max(4_000),
  }).strict(),
}).strict()

/** Parse a private, operator-supplied fixture without ever copying its real question text into reports. */
export function loadPinnedQuestionFixture(
  raw: string,
  questions: readonly Pick<GoldenQuestion, 'id' | 'source'>[],
): Record<string, string> {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    throw new Error('Pinned Maxx question fixture is not valid JSON.')
  }
  const fixture = pinnedQuestionFixtureSchema.parse(input)
  const ownerQuestions = questions.filter((question) => question.source === 'owner')
  if (ownerQuestions.length !== 1) {
    throw new Error('Maxx eval must define exactly one owner question.')
  }
  if (fixture.owner_question.id !== ownerQuestions[0].id) {
    throw new Error(`Pinned Maxx fixture owner question must be ${ownerQuestions[0].id}.`)
  }
  return { [fixture.owner_question.id]: fixture.owner_question.prompt }
}
