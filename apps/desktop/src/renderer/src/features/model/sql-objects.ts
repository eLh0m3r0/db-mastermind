/**
 * A model tab's views, sequences, procedures and triggers after an edit. Save reads `[]` as "the project has none
 * now" (the last one was deleted) and `undefined` as "this tab never loaded them" (the file's are left alone), so an
 * empty list stays empty once the tab has had the project's list, and stays undefined only when it never had.
 */
export function objectsAfterEdit<T>(kept: T[], before: T[] | undefined): T[] | undefined {
  return kept.length || before !== undefined ? kept : undefined
}
