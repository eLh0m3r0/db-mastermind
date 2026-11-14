/**
 * Passwords from a password manager: the connection's `passwordCommand` runs when connecting and its first line of
 * output is the password, which is never saved. Must not import 'electron' (the MCP child may use it).
 */
import { exec } from 'node:child_process'
import type { ConnectionConfig } from '@dbmastermind/core'

/** Long enough for a biometric or master-password prompt of the password manager. */
const TIMEOUT_MS = 60_000

export class PasswordCommandError extends Error {
  override name = 'PasswordCommandError'
  readonly code = 'PASSWORD_COMMAND'
}

export function runPasswordCommand(command: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const why = (err as { killed?: boolean }).killed ? `it did not finish within ${Math.round(timeoutMs / 1000)} s` : (stderr.trim().split(/\r?\n/)[0] ?? '') || err.message
        reject(new PasswordCommandError(`The password command failed: ${why}`))
        return
      }
      const password = stdout.split(/\r?\n/)[0] ?? ''
      if (!password) reject(new PasswordCommandError('The password command printed nothing'))
      else resolve(password)
    })
  })
}

/**
 * The connection with its password from its command, when it has no password of its own. Connections from a team
 * folder or a managed configuration never run one (anyone with access to the shared folder could set it).
 */
export async function withCommandPassword<T extends ConnectionConfig & { team?: boolean; managed?: boolean }>(config: T): Promise<T> {
  const command = config.passwordCommand?.trim()
  if (config.password || !command || config.team || config.managed) return config
  return { ...config, password: await runPasswordCommand(command) }
}
