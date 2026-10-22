import { API_METHODS, type MastermindApi } from '@shared/api'

/** An error from the main process with its code (database error codes, PASSWORD_REQUIRED…). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    name?: string,
  ) {
    super(message)
    if (name) this.name = name
  }
}

// Built here rather than in the preload: errors thrown across contextBridge lose everything but their message.
export const api = Object.fromEntries(
  API_METHODS.map((method) => [
    method,
    async (...args: unknown[]) => {
      const result = await window.mastermind.call(method, args)
      if (result.ok) return result.value
      throw new ApiError(result.error.message, result.error.code, result.error.name)
    },
  ]),
) as unknown as MastermindApi
export const bridge = window.mastermind
export const isMac = window.mastermind.platform === 'darwin'
export const modKey = isMac ? '⌘' : 'Ctrl'
const modifierRank = (k: string) => {
  const i = ['Ctrl', 'Shift', 'Alt'].indexOf(k)
  return i < 0 ? 9 : i
}
/** A shortcut written the Mac way (⇧⌘↵, ⌘S) as this platform shows it: Ctrl+Shift+Enter, Ctrl+S on Windows/Linux. */
export const keys = (mac: string): string =>
  isMac
    ? mac
    : [...mac]
        .map((c) => ({ '⌘': 'Ctrl', '⇧': 'Shift', '⌥': 'Alt', '↵': 'Enter', '⌫': 'Backspace' })[c] ?? c)
        .sort((a, b) => modifierRank(a) - modifierRank(b))
        .join('+')
