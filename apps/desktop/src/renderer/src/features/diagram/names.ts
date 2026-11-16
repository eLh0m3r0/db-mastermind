/**
 * Why a typed name can't be given to a table or a column: empty, or another one of its kind has it (names compare
 * without case, as the inline rename on the canvas does). `own` is the name it has now: keeping it is fine.
 */
export function nameProblem(name: string, own: string, others: string[]): 'empty' | 'taken' | undefined {
  const typed = name.trim()
  if (!typed) return 'empty'
  if (typed.toLowerCase() === own.toLowerCase()) return undefined
  return others.some((o) => o.toLowerCase() === typed.toLowerCase()) ? 'taken' : undefined
}
