import { execFile, spawn } from 'node:child_process'
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

export type CliEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end'; id: string; output: string; error?: boolean }

export interface CliRunOptions {
  provider: 'claude-code' | 'codex'
  prompt: string
  system: string
  model?: string
  mcp: { command: string; args: string[] }
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
  const env = { ...process.env, PATH: await resolvedPath() }
  let args: string[]
  if (options.provider === 'claude-code') {
    const mcpConfig = JSON.stringify({ mcpServers: { dbmastermind: { command: options.mcp.command, args: options.mcp.args } } })
    args = [
      '-p',
      options.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__dbmastermind',
      '--append-system-prompt',
      options.system,
    ]
    if (options.model) args.push('--model', options.model)
  } else {
    const toml = (v: unknown) => JSON.stringify(v)
    args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c',
      `mcp_servers.dbmastermind.command=${toml(options.mcp.command)}`,
      '-c',
      `mcp_servers.dbmastermind.args=${toml(options.mcp.args)}`,
      ...(options.model ? ['-m', options.model] : []),
      `${options.system}\n\n---\n\n${options.prompt}`,
    ]
  }

  const child = spawn(binary(options.provider), args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const onAbort = () => child.kill()
  options.signal.addEventListener('abort', onAbort, { once: true })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))

  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (options.provider === 'claude-code') {
      const message = msg.message as { content?: unknown[] } | undefined
      if (msg.type === 'assistant') {
        for (const block of message?.content ?? []) {
          const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown }
          if (b.type === 'text' && b.text) options.onEvent({ type: 'text', text: b.text })
          if (b.type === 'tool_use') options.onEvent({ type: 'tool-start', id: b.id ?? '', name: toolName(b.name ?? ''), input: b.input })
        }
      } else if (msg.type === 'user') {
        for (const block of message?.content ?? []) {
          const b = block as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
          if (b.type === 'tool_result') options.onEvent({ type: 'tool-end', id: b.tool_use_id ?? '', output: textOf(b.content), error: b.is_error })
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
  if (code !== 0) {
    throw new Error(stderr.trim() || `${binary(options.provider)} exited with code ${code}`)
  }
}
