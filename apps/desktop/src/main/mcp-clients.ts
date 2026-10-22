import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpClientId, McpClientStatus } from '../shared/api'

/** The MCP server entry the clients get: how to start DB Mastermind in `--mcp` mode. */
export interface McpLaunch {
  command: string
  args: string[]
}

const NAME = 'dbmastermind'

interface ClientDef {
  id: McpClientId
  label: string
  /** The config file this app edits, or null when the platform has no such client. */
  path: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string) => string | null
  /** The folder whose presence means the client is installed. */
  marker: (path: string, home: string) => string
  merge: (text: string, launch: McpLaunch) => string
  has: (text: string) => boolean
}

function appData(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') return env.APPDATA ?? join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  return env.XDG_CONFIG_HOME ?? join(home, '.config')
}

function parseObject(text: string, path: string): Record<string, unknown> {
  if (!text.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not plain JSON (comments?). Add the entry by hand using the snippet below.`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} does not contain a JSON object.`)
  return value as Record<string, unknown>
}

/** Sets `root[key].dbmastermind = entry`, keeping every other server and setting. */
export function mergeJsonServers(text: string, key: 'mcpServers' | 'servers', entry: Record<string, unknown>, path = 'The config file'): string {
  const root = parseObject(text, path)
  const servers = root[key] && typeof root[key] === 'object' && !Array.isArray(root[key]) ? (root[key] as Record<string, unknown>) : {}
  return JSON.stringify({ ...root, [key]: { ...servers, [NAME]: entry } }, null, 2) + '\n'
}

function hasJsonServer(text: string, key: 'mcpServers' | 'servers'): boolean {
  try {
    const servers = (JSON.parse(text) as Record<string, Record<string, unknown> | undefined>)[key]
    return !!servers && NAME in servers
  } catch {
    return false
  }
}

const TOML_HEADER = new RegExp(`^\\[mcp_servers\\.(?:${NAME}|"${NAME}")\\]\\s*$`)

/** Adds or replaces the `[mcp_servers.dbmastermind]` table in a Codex `config.toml`, leaving the rest as written. */
export function mergeCodexToml(text: string, launch: McpLaunch): string {
  // JSON string escapes are valid TOML basic-string escapes.
  const section = [`[mcp_servers.${NAME}]`, `command = ${JSON.stringify(launch.command)}`, `args = [${launch.args.map((a) => JSON.stringify(a)).join(', ')}]`]
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : []
  const start = lines.findIndex((l) => TOML_HEADER.test(l.trim()))
  if (start < 0) {
    while (lines.length && !lines.at(-1)!.trim()) lines.pop()
    return [...lines, ...(lines.length ? [''] : []), ...section, ''].join('\n')
  }
  let end = start + 1
  // The table runs to the next header; its own subtables ([mcp_servers.dbmastermind.env]) go with it.
  while (end < lines.length && !(/^\s*\[/.test(lines[end]!) && !lines[end]!.trim().startsWith(`[mcp_servers.${NAME}.`))) end++
  while (end > start + 1 && !lines[end - 1]!.trim()) end--
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n').replace(/\n*$/, '\n')
}

const CLIENTS: ClientDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: (_env, _platform, home) => join(home, '.claude.json'),
    marker: (_path, home) => join(home, '.claude'),
    merge: (text, launch) => mergeJsonServers(text, 'mcpServers', { type: 'stdio', command: launch.command, args: launch.args, env: {} }, '~/.claude.json'),
    has: (text) => hasJsonServer(text, 'mcpServers'),
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    path: (env, platform, home) => join(appData(env, platform, home), 'Claude', 'claude_desktop_config.json'),
    marker: (path) => dirname(path),
    merge: (text, launch) => mergeJsonServers(text, 'mcpServers', { command: launch.command, args: launch.args }, 'claude_desktop_config.json'),
    has: (text) => hasJsonServer(text, 'mcpServers'),
  },
  {
    id: 'codex',
    label: 'Codex',
    path: (env, _platform, home) => join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
    marker: (path) => dirname(path),
    merge: (text, launch) => mergeCodexToml(text, launch),
    has: (text) => text.split(/\r?\n/).some((l) => TOML_HEADER.test(l.trim())),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    path: (_env, _platform, home) => join(home, '.cursor', 'mcp.json'),
    marker: (path) => dirname(path),
    merge: (text, launch) => mergeJsonServers(text, 'mcpServers', { command: launch.command, args: launch.args }, '~/.cursor/mcp.json'),
    has: (text) => hasJsonServer(text, 'mcpServers'),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    path: (env, platform, home) => join(appData(env, platform, home), 'Code', 'User', 'mcp.json'),
    marker: (path) => dirname(path),
    merge: (text, launch) => mergeJsonServers(text, 'servers', { type: 'stdio', command: launch.command, args: launch.args }, 'mcp.json'),
    has: (text) => hasJsonServer(text, 'servers'),
  },
]

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function mcpClientStatuses(env = process.env, platform = process.platform, home = homedir()): McpClientStatus[] {
  return CLIENTS.map((c) => {
    const path = c.path(env, platform, home)!
    return { id: c.id, label: c.label, path, installed: existsSync(c.marker(path, home)), configured: c.has(read(path)) }
  })
}

/** Runs `claude mcp add`, so a running Claude Code doesn't overwrite our edit of its config file. */
function claudeCli(launch: McpLaunch): Promise<boolean> {
  const args = ['mcp', 'add', '--scope', 'user', NAME, '--', launch.command, ...launch.args]
  // `claude` is a .cmd shim on Windows, which needs a shell; quote everything for cmd.exe.
  const win = process.platform === 'win32'
  const run = (a: string[]) =>
    new Promise<boolean>((resolve) =>
      execFile(win ? 'claude.cmd' : 'claude', win ? a.map((x) => `"${x}"`) : a, { timeout: 20_000, shell: win, windowsHide: true }, (err) => resolve(!err)),
    )
  // `add` fails when the name exists; remove the old entry first.
  return run(['mcp', 'remove', '--scope', 'user', NAME]).then(() => run(args))
}

/**
 * Registers DB Mastermind as an MCP server in another app's config. The previous file is kept
 * next to it as `.bak`. Returns the file that was changed.
 */
export async function addToMcpClient(id: McpClientId, launch: McpLaunch, env = process.env, platform = process.platform, home = homedir()): Promise<{ path: string; via: 'cli' | 'file'; backup: boolean }> {
  const client = CLIENTS.find((c) => c.id === id)
  if (!client) throw new Error(`Unknown MCP client: ${id}`)
  const path = client.path(env, platform, home)!
  if (id === 'claude-code' && (await claudeCli(launch))) return { path, via: 'cli', backup: false }
  const before = read(path)
  const after = client.merge(before, launch)
  mkdirSync(dirname(path), { recursive: true })
  if (before) copyFileSync(path, `${path}.bak`)
  writeFileSync(path, after)
  return { path, via: 'file', backup: !!before }
}
