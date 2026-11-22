import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { reportIssueUrl } from './report-issue'
import { getSettings } from './settings'
import type { MenuContext } from '@shared/api'

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
  'Save': 'Uložit',
  'Export Results…': 'Exportovat výsledky…',
  Disconnect: 'Odpojit',
  'New Model': 'Nový model',
  'Open Model…': 'Otevřít model…',
  'Open SQL File…': 'Otevřít SQL soubor…',
  'Run on Several Connections…': 'Spustit na více připojeních…',
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
  'Commit Transaction': 'Potvrdit transakci (Commit)',
  'Roll Back Transaction': 'Vrátit transakci (Rollback)',
  'Format SQL': 'Formátovat SQL',
  'Ask AI…': 'Zeptat se AI…',
  History: 'Historie',
  'Saved Queries': 'Uložené dotazy',
  Dashboards: 'Dashboardy',
  'DB Mastermind Website': 'Web DB Mastermind',
  Documentation: 'Dokumentace',
  Roadmap: 'Plán vývoje',
  'Report an Issue': 'Nahlásit problém',
  'Check for Updates…': 'Zkontrolovat aktualizace…',
  'Support DB Mastermind (Ko-fi)': 'Podpořit DB Mastermind (Ko-fi)',
  'Keyboard Shortcuts': 'Klávesové zkratky',
  Edit: 'Úpravy',
  Undo: 'Zpět',
  Redo: 'Znovu',
  Cut: 'Vyjmout',
  Copy: 'Kopírovat',
  Paste: 'Vložit',
  'Paste and Match Style': 'Vložit a přizpůsobit styl',
  Delete: 'Smazat',
  'Select All': 'Vybrat vše',
  Window: 'Okno',
  Minimize: 'Minimalizovat',
  Zoom: 'Zvětšit',
  'Bring All to Front': 'Převést vše do popředí',
  'Close Window': 'Zavřít okno',
  Help: 'Nápověda',
  'About DB Mastermind': 'O aplikaci DB Mastermind',
  Services: 'Služby',
  'Hide DB Mastermind': 'Skrýt DB Mastermind',
  'Hide Others': 'Skrýt ostatní',
  'Show All': 'Zobrazit vše',
  'Quit DB Mastermind': 'Ukončit DB Mastermind',
  Exit: 'Konec',
}

/** Native menu text in the UI language (the renderer has its own dictionary). */
function m(label: string): string {
  return getSettings().language === 'cs' ? (CS[label] ?? label) : label
}

export function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  // Accelerators are only displayed; the renderer's keymap handles the keys (see lib/keymap.ts).
  const cmd = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({
    id: command,
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
              { role: 'about', label: m('About DB Mastermind') },
              { type: 'separator' },
              cmd(m('Settings…'), 'settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services', label: m('Services') },
              { type: 'separator' },
              { role: 'hide', label: m('Hide DB Mastermind') },
              { role: 'hideOthers', label: m('Hide Others') },
              { role: 'unhide', label: m('Show All') },
              { type: 'separator' },
              { role: 'quit', label: m('Quit DB Mastermind') },
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
        cmd(m('New Model'), 'new-model'),
        cmd(m('Open Model…'), 'open-model', 'CmdOrCtrl+O'),
        cmd(m('Open SQL File…'), 'open-sql-file', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        cmd(m('Close Tab'), 'close-tab', 'CmdOrCtrl+W'),
        cmd(m('Reopen Closed Tab'), 'reopen-tab', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        cmd(m('Save'), 'save-query', 'CmdOrCtrl+S'),
        cmd(m('Export Results…'), 'export', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        cmd(m('Disconnect'), 'disconnect'),
        ...(isMac ? [] : [{ type: 'separator' } as const, cmd(m('Settings…'), 'settings', 'Ctrl+,'), { role: 'quit', label: m('Exit') } as const]),
      ],
    },
    // Role items keep the system's behaviour and shortcuts; only their text is ours (no English menus in Czech).
    {
      label: m('Edit'),
      submenu: [
        { role: 'undo', label: m('Undo') },
        { role: 'redo', label: m('Redo') },
        { type: 'separator' },
        { role: 'cut', label: m('Cut') },
        { role: 'copy', label: m('Copy') },
        { role: 'paste', label: m('Paste') },
        ...(isMac ? [{ role: 'pasteAndMatchStyle', label: m('Paste and Match Style') } as const] : []),
        { role: 'delete', label: m('Delete') },
        { role: 'selectAll', label: m('Select All') },
      ],
    },
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
        cmd(m('Run on Several Connections…'), 'run-on-connections'),
        cmd(m('Cancel Query'), 'cancel-query', 'CmdOrCtrl+.'),
        { type: 'separator' },
        cmd(m('Commit Transaction'), 'commit-transaction', 'CmdOrCtrl+Alt+Shift+Enter'),
        cmd(m('Roll Back Transaction'), 'rollback-transaction', 'CmdOrCtrl+Alt+Shift+Backspace'),
        { type: 'separator' },
        cmd(m('Format SQL'), 'format-sql', 'CmdOrCtrl+Shift+F'),
        cmd(m('Ask AI…'), 'ask-ai', 'CmdOrCtrl+I'),
        { type: 'separator' },
        cmd(m('History'), 'history', isMac ? 'Cmd+Y' : 'Ctrl+Shift+H'),
        cmd(m('Saved Queries'), 'saved-queries'),
        cmd(m('Dashboards'), 'dashboards'),
      ],
    },
    {
      role: 'windowMenu',
      label: m('Window'),
      submenu: [
        { role: 'minimize', label: m('Minimize') },
        { role: 'zoom', label: m('Zoom') },
        ...(isMac ? [{ type: 'separator' } as const, { role: 'front', label: m('Bring All to Front') } as const] : [{ role: 'close', label: m('Close Window') } as const]),
      ],
    },
    {
      role: 'help',
      label: m('Help'),
      submenu: [
        { label: m('DB Mastermind Website'), click: () => void shell.openExternal('https://dbmastermind.app') },
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
  applyContext()
}

const isQuery = (c: MenuContext) => c.tab === 'query'
const isData = (c: MenuContext) => c.tab === 'query' || c.tab === 'table'
/** Commands that only act in some tabs: elsewhere they would do nothing, so the menu greys them out. */
const APPLIES: Record<string, (c: MenuContext) => boolean> = {
  'run-current': isQuery,
  'run-all': isQuery,
  'cancel-query': isQuery,
  'format-sql': isQuery,
  'commit-transaction': isData,
  'rollback-transaction': isData,
  export: isData,
  'save-query': (c) => isData(c) || c.tab === 'model' || c.tab === 'knowledge',
  'close-tab': (c) => !!c.tab,
  disconnect: (c) => c.connected,
  // The sidebar shows these lists for the selected connection only.
  history: (c) => !!c.connection,
  'saved-queries': (c) => !!c.connection,
  dashboards: (c) => !!c.connection,
  'refresh-schema': (c) => c.connected,
}

let context: MenuContext = { connected: false }

function applyContext(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const [id, applies] of Object.entries(APPLIES)) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = applies(context)
  }
}

export function setMenuContext(next: MenuContext): void {
  context = next
  applyContext()
}
