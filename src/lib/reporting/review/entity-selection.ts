import type { ReviewFinding } from './contracts'

/** Names, prose and ID prefixes are not entity identity. Keep hierarchy in the key. */
export function reviewEntityKey(entity: NonNullable<ReviewFinding['entity']>): string {
  return `${entity.level}:${entity.id}`
}

export function matchesReviewEntity(finding: ReviewFinding, selection: string | null): boolean {
  return !selection || Boolean(finding.entity && reviewEntityKey(finding.entity) === selection)
}
