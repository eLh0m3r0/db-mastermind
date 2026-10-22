export const api = window.mastermind.api
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
