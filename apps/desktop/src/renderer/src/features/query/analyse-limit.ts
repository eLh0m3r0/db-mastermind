/**
 * Above this many characters the editor's warnings and ⌘-hover links stay off: both parse the whole document, the
 * linter after every pause in typing and the hover on every mouse move, which makes a multi-megabyte dump stutter.
 */
export const ANALYSE_LIMIT = 300_000

export const analysable = (length: number): boolean => length <= ANALYSE_LIMIT
