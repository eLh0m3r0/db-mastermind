const DENIED = 'The server did not allow reading its statement statistics: '

/**
 * Why the top queries can't be shown, in the UI language. Core's message is a template (the server's error, then
 * what privilege is needed), so it can't be looked up as a whole: its parts are.
 */
export function topQueriesReason(reason: string, t: (text: string, vars?: Record<string, string>) => string): string {
  if (!reason.startsWith(DENIED)) return t(reason)
  const rest = reason.slice(DENIED.length)
  const hint = rest.match(/ (It needs .*)$/s)
  const error = (hint ? rest.slice(0, hint.index) : rest).replace(/\.$/, '')
  return t('The server did not allow reading its statement statistics: {error}. {hint}', { error, hint: hint ? t(hint[1]!) : '' }).trim()
}
