import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { reportIssueUrl } from './report-issue'
import { getSettings } from './settings'

function sendCommand(command: string) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu:command', command)
}

const CS: Record<string, string> = {
  'Settings…': 'Nastavení…',
  File: 'Soubor',
  'New Query Tab': 'Nový dotaz',
  'New Connection…': 'Nové připojení…',
  'Close Tab': 'Zavřít záložku',
  'Reopen Closed Tab': 'Znovu otevřít zavřenou záložku',
  'Save Query': 'Uložit dotaz',
  'Export Results…': 'Exportovat výsledky…',
  Disconnect: 'Odpojit',
  View: 'Zobrazení',
  'Command Palette…': 'Paleta příkazů…',
  'Quick Open Table…': 'Rychle otevřít tabulku…',
  'Toggle Sidebar': 'Přepnout boční panel',
  'Toggle AI Assistant': 'Přepnout AI asistenta',
  'Refresh Schema': 'Obnovit schéma',
  Query: 'Dotaz',
  'Run Statement / Selection': 'Spustit příkaz / výběr',
  'Run All': 'Spustit vše',
  'Cancel Query': 'Zrušit dotaz',
  'Format SQL': 'Formátovat SQL',
  'Ask AI…': 'Zeptat se AI…',
  History: 'Historie',
  'Saved Queries': 'Uložené dotazy',
  Documentation: 'Dokumentace',
  Roadmap: 'Plán vývoje',
  'Report an Issue': 'Nahlásit problém',
  'Check for Updates…': 'Zkontrolovat aktualizace…',
  'Support DB Mastermind (Ko-fi)': 'Podpořit DB Mastermind (Ko-fi)',
  'Keyboard Shortcuts': 'Klávesové zkratky',
}

/** Native menu text in the UI language (the renderer has its own dictionary). */
function m(label: string): string {
  return getSettings().language === 'cs' ? (CS[label] ?? label) : label
}

export function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  // Accelerators are only displayed; the renderer's keymap handles the keys (see lib/keymap.ts).
  const cmd = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => sendCommand(command),
  })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              cmd(m('Settings…'), 'settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: m('File'),
      submenu: [
        cmd(m('New Query Tab'), 'new-query', 'CmdOrCtrl+T'),
        cmd(m('New Connection…'), 'new-connection', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        cmd(m('Close Tab'), 'close-tab', 'CmdOrCtrl+W'),
        cmd(m('Reopen Closed Tab'), 'reopen-tab', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        cmd(m('Save Query'), 'save-query', 'CmdOrCtrl+S'),
        cmd(m('Export Results…'), 'export', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        cmd(m('Disconnect'), 'disconnect'),
        ...(isMac ? [] : [{ type: 'separator' } as const, cmd(m('Settings…'), 'settings', 'Ctrl+,'), { role: 'quit' } as const]),
      ],
    },
    { role: 'editMenu' },
    {
      label: m('View'),
      submenu: [
        cmd(m('Command Palette…'), 'palette', 'CmdOrCtrl+K'),
        cmd(m('Quick Open Table…'), 'quick-open', 'CmdOrCtrl+P'),
        { type: 'separator' },
        cmd(m('Toggle Sidebar'), 'toggle-sidebar', 'CmdOrCtrl+B'),
        cmd(m('Toggle AI Assistant'), 'toggle-ai', 'CmdOrCtrl+J'),
        { type: 'separator' },
        cmd(m('Refresh Schema'), 'refresh-schema', 'F5'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const, { role: 'reload' } as const]),
      ],
    },
    {
      label: m('Query'),
      submenu: [
        cmd(m('Run Statement / Selection'), 'run-current', 'CmdOrCtrl+Enter'),
        cmd(m('Run All'), 'run-all', 'CmdOrCtrl+Shift+Enter'),
        cmd(m('Cancel Query'), 'cancel-query', 'CmdOrCtrl+.'),
        { type: 'separator' },
        cmd(m('Format SQL'), 'format-sql', 'CmdOrCtrl+Shift+F'),
        cmd(m('Ask AI…'), 'ask-ai', 'CmdOrCtrl+I'),
        { type: 'separator' },
        cmd(m('History'), 'history', 'CmdOrCtrl+Y'),
        cmd(m('Saved Queries'), 'saved-queries'),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: m('Documentation'), click: () => void shell.openExternal('https://github.com/eLh0m3r0/db-mastermind#readme') },
        { label: m('Roadmap'), click: () => void shell.openExternal('https://github.com/eLh0m3r0/db-mastermind/blob/main/ROADMAP.md') },
        { label: m('Report an Issue'), click: () => void shell.openExternal(reportIssueUrl()) },
        cmd(m('Check for Updates…'), 'check-updates'),
        { label: m('Support DB Mastermind (Ko-fi)'), click: () => void shell.openExternal('https://ko-fi.com/vaclavmudra') },
        { type: 'separator' },
        cmd(m('Keyboard Shortcuts'), 'shortcuts'),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
