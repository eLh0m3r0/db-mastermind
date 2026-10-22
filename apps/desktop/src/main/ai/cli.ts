import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let shellPath: Promise<string> | undefined

/**
 * Apps started from Finder/Explorer don't inherit the shell PATH, so `claude` / `codex` installed via npm,
 * Homebrew or ~/.local/bin wouldn't be found. Ask the login shell once.
 */
export function resolvedPath(): Promise<string> {
  shellPath ??= (async () => {
    const extra =
      process.platform === 'win32'
        ? [process.env.APPDATA ? `${process.env.APPDATA}\\npm` : '', process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs` : '']
        : ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.npm-global/bin`, `${process.env.HOME}/.claude/local`]
    let fromShell = ''
    if (process.platform !== 'win32') {
      try {
        const shell = process.env.SHELL || '/bin/zsh'
        const { stdout } = await execFileAsync(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { timeout: 5000 })
        fromShell = stdout.split('__PATH__').pop()?.trim() ?? ''
      } catch {
        // Fall back to well-known locations.
      }
    }
    const sep = process.platform === 'win32' ? ';' : ':'
    return [fromShell, process.env.PATH ?? '', ...extra].filter(Boolean).join(sep)
  })()
  return shellPath
}

/** Codex features that would reach beyond DB Mastermind's tools (files, shell, browser, other apps). */
export const CODEX_DISABLED_FEATURES = ['shell_tool', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'apps', 'plugins', 'remote_plugin']

function binary(provider: 'claude-code' | 'codex'): string {
  return provider === 'codex' ? 'codex' : 'claude'
}

export async function cliAvailable(provider: 'claude-code' | 'codex'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary(provider), ['--version'], {
      env: { ...process.env, PATH: await resolvedPath() },
      timeout: 15_000,
      shell: process.platform === 'win32',
    })
    return stdout.trim().split('\n')[0] ?? binary(provider)
  } catch {
    return null
  }
}

/** How to sign in, for messages. */
export function loginHint(provider: 'claude-code' | 'codex'): string {
  return provider === 'codex' ? 'run `codex login` in a terminal' : 'run `claude auth login` in a terminal'
}

/**
 * Whether the CLI is signed in: `claude auth status` (JSON) or `codex login status` (exit code). Null when it can't
 * tell (an older CLI without the command), which callers treat as "probably fine".
 */
export async function cliLoggedIn(provider: 'claude-code' | 'codex'): Promise<{ loggedIn: boolean; detail?: string } | null> {
  const args = provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']
  const env = { ...process.env, PATH: await resolvedPath() }
  try {
    const { stdout, stderr } = await execFileAsync(binary(provider), args, { env, timeout: 15_000, shell: process.platform === 'win32' })
    // Codex prints its status on stderr.
    const text = `${stdout}\n${stderr}`.trim()
    if (provider === 'codex') return { loggedIn: !/not logged in/i.test(text), detail: text.split('\n').find((l) => /logged in/i.test(l))?.trim().replace(/^Logged in (using\s+)?/i, '') }
    const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string }
    return typeof status.loggedIn === 'boolean' ? { loggedIn: status.loggedIn, detail: status.authMethod } : null
  } catch (err) {
    const out = `${(err as { stdout?: string }).stdout ?? ''}\n${(err as { stderr?: string }).stderr ?? ''}`
    if (provider === 'codex' && /not logged in/i.test(out)) return { loggedIn: false }
    // `claude auth status` exits with 1 when signed out, still printing its JSON.
    try {
      const status = JSON.parse((err as { stdout?: string }).stdout ?? '') as { loggedIn?: boolean }
      if (status.loggedIn === false) return { loggedIn: false }
    } catch {
      // Not JSON: an older CLI without `auth status`.
    }
    return null
  }
}

export type CliEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; output: string; error?: boolean }

export interface CliRunOptions {
  provider: 'claude-code' | 'codex'
  prompt: string
  system: string
  model?: string
  /**
   * DB Mastermind as an MCP server for the agent: a command to start, or (Claude Code) the app's own endpoint for this
   * chat. Omitted for plain text completions.
   */
  mcp?: { command: string; args: string[] } | { url: string; headers: Record<string, string> }
  signal: AbortSignal
  onEvent: (event: CliEvent) => void
}

function toolName(name: string): string {
  return name.replace(/^mcp__dbmastermind__/, '')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : '')).join('')
  return JSON.stringify(content)
}

/** Runs the agent CLI headless with DB Mastermind attached as an MCP server and streams its events. */
export async function runCli(options: CliRunOptions): Promise<void> {
  // A write waits in the app for the user's answer; Claude Code would give up on the tool call after its default timeout.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: await resolvedPath(), MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '900000' }
  let args: string[]
  let stdin: string | undefined
  // Long texts (prompt, system prompt, MCP config with its token) never go on the command line: on Windows the CLI
  // runs through cmd.exe, which splits unquoted arguments and can't take newlines at all.
  const scratch = mkdtempSync(join(tmpdir(), 'dbm-agent-'))
  const file = (name: string, text: string) => {
    const path = join(scratch, name)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }
  if (options.provider === 'claude-code') {
    stdin = options.prompt
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--append-system-prompt-file', file('system.md', options.system)]
    if (options.mcp) {
      const server = 'url' in options.mcp ? { type: 'http', url: options.mcp.url, headers: options.mcp.headers } : { command: options.mcp.command, args: options.mcp.args }
      args.push('--mcp-config', file('mcp.json', JSON.stringify({ mcpServers: { dbmastermind: server } })), '--strict-mcp-config', '--allowedTools', 'mcp__dbmastermind')
    } else {
      args.push('--strict-mcp-config')
    }
    // No built-in tools at all: in print mode Claude Code still allows its read-only ones (Read, Glob, Grep), which
    // could open a database file directly and get round the connection's AI permissions. DB Mastermind's tools are
    // the only way to the data.
    args.push('--tools', '', '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'Agent')
    if (options.model) args.push('--model', options.model)
  } else {
    // Codex gets the same per-chat endpoint as Claude Code, so tools follow the chat's permissions and writes are
    // confirmed in the app. Everything else Codex could reach is switched off: its own shell (which could read a
    // database file and get round the permissions), browser, computer use, web search, apps and plugins, the user's
    // own config (other MCP servers) and saved sessions. The prompt goes in on stdin.
    stdin = `${options.system}\n\n---\n\n${options.prompt}`
    const codex = codexArgs({ mcp: options.mcp, model: options.model, workdir: scratch })
    args = codex.args
    Object.assign(env, codex.env)
  }

  const windows = process.platform === 'win32'
  const child = spawn(binary(options.provider), windows ? args.map(cmdArg) : args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: windows })
  child.stdin.end(stdin ?? '')
  child.once('close', () => rmSync(scratch, { recursive: true, force: true }))
  const onAbort = () => child.kill()
  options.signal.addEventListener('abort', onAbort, { once: true })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))

  // Only our MCP tools are interesting to the user; agents also use internal tools (ToolSearch, TodoWrite…).
  const ours = new Set<string>()
  /** Failure the CLI reported in its event stream (expired login, quota…). */
  let failure: string | undefined
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.type === 'result' && msg.is_error) failure = String(msg.result ?? 'Claude Code failed')
    if (msg.type === 'turn.failed') failure = String((msg.error as { message?: string } | undefined)?.message ?? 'Codex failed')
    if (options.provider === 'claude-code') {
      const message = msg.message as { content?: unknown[] } | undefined
      if (msg.type === 'assistant') {
        for (const block of message?.content ?? []) {
          const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown }
          if (b.type === 'text' && b.text) options.onEvent({ type: 'text', text: b.text })
          if (b.type === 'tool_use' && b.name?.startsWith('mcp__dbmastermind__')) {
            ours.add(b.id ?? '')
            options.onEvent({ type: 'tool-start', id: b.id ?? '', name: toolName(b.name), input: b.input })
          }
        }
      } else if (msg.type === 'user') {
        for (const block of message?.content ?? []) {
          const b = block as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
          if (b.type === 'tool_result' && ours.has(b.tool_use_id ?? '')) options.onEvent({ type: 'tool-end', id: b.tool_use_id ?? '', output: textOf(b.content), error: b.is_error })
        }
      }
    } else {
      const item = msg.item as { id?: string; type?: string; text?: string; tool?: string; arguments?: unknown; result?: unknown; error?: unknown } | undefined
      if (!item) return
      if (item.type === 'agent_message' && msg.type === 'item.completed' && item.text) options.onEvent({ type: 'text', text: item.text })
      if (item.type === 'mcp_tool_call') {
        if (msg.type === 'item.started') options.onEvent({ type: 'tool-start', id: item.id ?? '', name: toolName(item.tool ?? ''), input: item.arguments })
        if (msg.type === 'item.completed')
          options.onEvent({ type: 'tool-end', id: item.id ?? '', output: textOf((item.result as { content?: unknown })?.content ?? item.error ?? ''), error: !!item.error })
      }
    }
  })

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  options.signal.removeEventListener('abort', onAbort)
  if (options.signal.aborted) return
  if (failure || code !== 0) {
    const detail = failure ?? (stderr.trim().split('\n').filter((l) => !/^\S+Z\s+(ERROR|WARN)/.test(l)).join('\n') || stderr.trim() || `exited with code ${code}`)
    const name = options.provider === 'codex' ? 'Codex' : 'Claude Code'
    const login = /401|unauthori[sz]ed|log ?in|sign in|expired|credential/i.test(`${detail}\n${stderr}`)
    throw new Error(`${name}: ${detail}${login ? `\nSign in again: ${loginHint(options.provider)}.` : ''}`)
  }
}

/** `codex exec` arguments (the prompt itself goes in on stdin) and the environment they rely on. */
export function codexArgs(options: Pick<CliRunOptions, 'mcp' | 'model'> & { workdir: string }): { args: string[]; env: Record<string, string> } {
  const toml = (v: unknown) => JSON.stringify(v)
  const env: Record<string, string> = {}
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '-C', options.workdir]
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature)
  args.push('-c', 'web_search="disabled"', '-c', 'approval_policy="never"')
  if (options.mcp && 'url' in options.mcp) {
    env.DBM_MCP_TOKEN = (options.mcp.headers.Authorization ?? '').replace(/^Bearer\s+/i, '')
    args.push('-c', `mcp_servers.dbmastermind.url=${toml(options.mcp.url)}`, '-c', 'mcp_servers.dbmastermind.bearer_token_env_var="DBM_MCP_TOKEN"')
    // A write waits for the user's answer in the app.
    args.push('-c', 'mcp_servers.dbmastermind.tool_timeout_sec=900')
  } else if (options.mcp) {
    args.push('-c', `mcp_servers.dbmastermind.command=${toml(options.mcp.command)}`, '-c', `mcp_servers.dbmastermind.args=${toml(options.mcp.args)}`)
  }
  if (options.model) args.push('-m', options.model)
  args.push('-')
  return { args, env }
}

/** One argument for cmd.exe (the CLIs are .cmd shims on Windows): quoted when needed, so it stays one argument. */
export function cmdArg(arg: string): string {
  if (arg === '') return '""'
  return /[\s"&|<>^()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}
