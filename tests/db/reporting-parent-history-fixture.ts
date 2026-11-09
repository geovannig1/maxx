import { prepareSavedDb } from './reporting-saved-fixture'

/**
 * The selected-parent history scope is part of the shipped schema every fixture database is built from, so there
 * is nothing left to apply. Kept as a no-op for the browser check scripts that still call it.
 */
export async function applyParentHistoryMigration(): Promise<void> {}
export async function prepareParentHistoryDb() {
  return prepareSavedDb()
}
