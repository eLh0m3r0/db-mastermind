import net from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from './types.js'

export interface SshTunnel {
  localHost: string
  localPort: number
  close(): Promise<void>
}

function connectConfig(ssh: SshConfig): ConnectConfig {
  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port ?? 22,
    username: ssh.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
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
function connectSsh(config: ConnectConfig, onGone: () => void): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client()
    let ready = false
    // A permanent listener: an SSH 'error' event without one (keepalive timeout, server restart) crashes the app.
    client.on('error', (err) => {
      if (!ready) reject(err)
      else onGone()
    })
    client.on('close', () => {
      if (!ready) reject(new Error('The SSH server closed the connection'))
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
  const config = connectConfig(ssh)
  let client: Client | undefined
  let connecting: Promise<Client> | undefined
  let closed = false
  const gone = (c: Client) => () => {
    if (client === c) client = undefined
  }
  const ensure = (): Promise<Client> => {
    if (client) return Promise.resolve(client)
    connecting ??= connectSsh(config, () => undefined)
      .then((c) => {
        c.removeAllListeners('close')
        c.on('close', gone(c))
        c.on('error', gone(c))
        if (closed) c.end()
        client = c
        return c
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
