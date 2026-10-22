import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname } from 'node:path'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from './types.js'

/**
 * Trusted SSH host keys, like OpenSSH's known_hosts: the first connection to a host remembers its key's fingerprint
 * (trust on first use); a different key later is refused, because that's what a server in the middle looks like.
 */
export interface KnownHosts {
  get(host: string): string | undefined
  set(host: string, fingerprint: string): void
  delete(host: string): void
}

const memoryHosts = new Map<string, string>()
let knownHosts: KnownHosts = { get: (h) => memoryHosts.get(h), set: (h, f) => void memoryHosts.set(h, f), delete: (h) => void memoryHosts.delete(h) }

/**
 * Keeps trusted host keys in a JSON file (`{ "[host]:port": "SHA256:…" }`). The app and its MCP server process share
 * it, so writes are atomic. A file that exists but can't be read fails closed: treating it as empty would accept any
 * key and then overwrite every other host's.
 */
export function useKnownHostsFile(file: string): void {
  const read = (): Record<string, string> => {
    if (!existsSync(file)) return {}
    try {
      const hosts: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) throw new Error('not a JSON object')
      return hosts as Record<string, string>
    } catch (err) {
      throw new Error(`The trusted SSH host keys (${file}) can't be read, so the server can't be verified: ${(err as Error).message}. Fix or delete the file.`)
    }
  }
  const write = (hosts: Record<string, string>) => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(hosts, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }
  knownHosts = {
    get: (h) => read()[h],
    set: (h, f) => write({ ...read(), [h]: f }),
    delete: (h) => {
      const hosts = read()
      delete hosts[h]
      write(hosts)
    },
  }
}

/** The known_hosts key of an SSH server. */
export const sshHostId = (host: string, port?: number) => `[${host.trim().toLowerCase()}]:${port ?? 22}`

export function trustedHostKey(host: string, port?: number): string | undefined {
  return knownHosts.get(sshHostId(host, port))
}

export function forgetHostKey(host: string, port?: number): void {
  knownHosts.delete(sshHostId(host, port))
}

/** OpenSSH-style fingerprint of a raw host key: `SHA256:` + unpadded base64. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export class HostKeyMismatchError extends Error {
  override name = 'HostKeyMismatchError'
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `The SSH server ${host} presented a different host key than before (expected ${expected}, got ${actual}). ` +
        'Someone may be intercepting the connection, or the server was reinstalled. If your administrator confirms the new key, ' +
        'forget the old one in the connection\'s SSH settings and connect again.',
    )
  }
}

export interface SshTunnel {
  localHost: string
  localPort: number
  /**
   * A database error while the SSH connection is failing, rephrased to say so: drivers otherwise only see their
   * socket closing ("Connection terminated unexpectedly").
   */
  explain(err: unknown): unknown
  close(): Promise<void>
}

function connectConfig(ssh: SshConfig, onRefused: (err: Error) => void): ConnectConfig {
  const id = sshHostId(ssh.host, ssh.port)
  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port ?? 22,
    username: ssh.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    hostVerifier: (key: Buffer) => {
      try {
        const actual = hostKeyFingerprint(key)
        const expected = knownHosts.get(id)
        if (!expected) {
          knownHosts.set(id, actual)
          return true
        }
        if (expected === actual) return true
        onRefused(new HostKeyMismatchError(`${ssh.host}:${ssh.port ?? 22}`, expected, actual))
      } catch (err) {
        onRefused(err as Error)
      }
      return false
    },
  }
  if (ssh.authMethod === 'password') config.password = ssh.password
  if (ssh.authMethod === 'privateKey') {
    config.privateKey = ssh.privateKey
    if (ssh.passphrase) config.passphrase = ssh.passphrase
  }
  if (ssh.authMethod === 'agent') {
    config.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK
  }
  return config
}

/** One SSH connection; resolves when it's ready. Later errors and the close are reported through `onGone`. */
function connectSsh(ssh: SshConfig, onGone: () => void): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client()
    let ready = false
    let mismatch: Error | undefined
    const config = connectConfig(ssh, (err) => (mismatch = err))
    // A permanent listener: an SSH 'error' event without one (keepalive timeout, server restart) crashes the app.
    client.on('error', (err) => {
      if (!ready) reject(mismatch ?? err)
      else onGone()
    })
    client.on('close', () => {
      if (!ready) reject(mismatch ?? new Error('The SSH server closed the connection'))
      else onGone()
    })
    client.once('ready', () => {
      ready = true
      resolve(client)
    })
    client.connect(config)
  })
}

/**
 * Opens an SSH connection and a local TCP listener forwarding to `targetHost:targetPort`. When the SSH connection
 * drops (bastion restart, VPN, laptop sleep), the next database connection through the tunnel reconnects it.
 */
export async function openSshTunnel(ssh: SshConfig, targetHost: string, targetPort: number): Promise<SshTunnel> {
  let client: Client | undefined
  let connecting: Promise<Client> | undefined
  let closed = false
  let failure: { message: string; at: number } | undefined
  const gone = (c: Client) => () => {
    if (client === c) client = undefined
  }
  const ensure = (): Promise<Client> => {
    if (client) return Promise.resolve(client)
    connecting ??= connectSsh(ssh, () => undefined)
      .then((c) => {
        c.removeAllListeners('close')
        c.on('close', gone(c))
        c.on('error', gone(c))
        if (closed) c.end()
        client = c
        failure = undefined
        return c
      })
      .catch((err: unknown) => {
        failure = { message: err instanceof Error ? err.message : String(err), at: Date.now() }
        throw err
      })
      .finally(() => {
        connecting = undefined
      })
    return connecting
  }
  // The first connection reports bad credentials or an unreachable host right away.
  await ensure()

  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    ensure()
      .then(
        (c) =>
          new Promise<void>((resolve, reject) => {
            try {
              c.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
                if (err) return reject(err)
                socket.pipe(stream).pipe(socket)
                stream.on('error', () => socket.destroy())
                stream.once('close', () => socket.destroy())
                socket.once('close', () => stream.close())
                resolve()
              })
            } catch (err) {
              // ssh2 throws synchronously when the connection went away in between.
              client = undefined
              reject(err)
            }
          }),
      )
      .catch(() => socket.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  server.on('error', () => undefined)
  const address = server.address() as net.AddressInfo

  return {
    localHost: '127.0.0.1',
    localPort: address.port,
    explain: (err) =>
      failure && Date.now() - failure.at < 60_000 && !(err instanceof HostKeyMismatchError)
        ? new Error(`The SSH tunnel through ${ssh.host}:${ssh.port ?? 22} is not working: ${failure.message}`, { cause: err })
        : err,
    close: () =>
      new Promise<void>((resolve) => {
        closed = true
        for (const s of sockets) s.destroy()
        server.close(() => {
          client?.end()
          client = undefined
          resolve()
        })
      }),
  }
}
