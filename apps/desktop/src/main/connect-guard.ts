/**
 * Guards around opening connections. Must not import 'electron' (unit tests).
 */
import { createConnection } from 'node:net'
import { DEFAULT_PORTS, type ConnectionConfig } from '@dbmastermind/core'

/** Where a connection's first TCP connection goes (the SSH server when tunnelled); undefined when that isn't known. */
export function firstHop(config: ConnectionConfig): { host: string; port: number } | undefined {
  const ssh = config.ssh?.enabled ? config.ssh : undefined
  if (ssh) {
    const hop = ssh.jump ?? ssh
    return hop.host ? { host: hop.host, port: hop.port ?? 22 } : undefined
  }
  let host = config.host?.trim()
  if (!host) return undefined
  let port = config.port
  if (host.includes('://')) {
    try {
      const url = new URL(host)
      host = url.hostname
      port ??= url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    } catch {
      return undefined
    }
  }
  // SQL Server named instances find their port through the browser service.
  if (!config.port && config.driver === 'mssql' && /\\/.test(host)) return undefined
  port ??= DEFAULT_PORTS[config.driver]
  return host && port ? { host, port } : undefined
}

/** Throws the socket's own error (ECONNREFUSED, ETIMEDOUT, ENOTFOUND…) when the first hop can't be reached. */
export function assertReachable(config: ConnectionConfig, timeoutMs = 5_000): Promise<void> {
  const hop = firstHop(config)
  if (!hop) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: hop.host, port: hop.port })
    const done = (err?: Error) => {
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => done(Object.assign(new Error(`connect ETIMEDOUT ${hop.host}:${hop.port}`), { code: 'ETIMEDOUT' })))
    socket.once('connect', () => done())
    socket.once('error', (err) => done(err))
  })
}

/** Calls for the same key while one is running share its promise (parallel requests open one connection). */
export function singleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<T>>()
  return (key, run) => {
    const pending = running.get(key)
    if (pending) return pending
    const p = run().finally(() => running.delete(key))
    running.set(key, p)
    return p
  }
}
