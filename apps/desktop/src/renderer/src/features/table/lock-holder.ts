/**
 * Which open transaction holds the rows a save found locked: only said when it can be told. This tab's own session
 * never locks itself out, and with several candidates any one named could be the wrong one.
 */
export function lockHolder(transactions: Record<string, { connectionId: string }>, connectionId: string, ownSession: string | undefined): { session: string; ai: boolean } | undefined {
  const others = Object.entries(transactions)
    .filter(([session, tx]) => tx.connectionId === connectionId && session !== ownSession)
    .map(([session]) => session)
  if (others.length !== 1) return undefined
  return { session: others[0]!, ai: others[0]!.startsWith('ai-') }
}
