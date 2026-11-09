/**
 * The selected-parent breakdown scope is part of the shipped schema every fixture database is built from, so there
 * is nothing left to apply. Kept as a no-op for the browser check scripts that still call it.
 */
export async function applyParentBreakdownMigration(): Promise<void> {}
