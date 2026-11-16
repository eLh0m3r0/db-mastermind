type Translate = (text: string, vars?: Record<string, string>) => string

const TOO_MANY = /^This change would have changed (\d+) rows, not only the one edited: the table's key doesn't identify one row\. ?(.*)$/s

/**
 * Core's TOO_MANY_ROWS message carries the number of rows and what to do next, so it can't be looked up whole in the
 * dictionary: its parts are. Any other message goes through `t` as it is.
 */
export function saveErrorText(message: string, t: Translate): string {
  const m = TOO_MANY.exec(message)
  if (!m) return t(message)
  const rows = t('This change would have changed {n} rows, not only the one edited: the table’s key doesn’t identify one row.', { n: m[1]! })
  return m[2] ? `${rows} ${t(m[2])}` : rows
}
