import net from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshConfig } from './types.js'

export interface SshTunnel {
  localHost: string
  localPort: number
  close(): Promise<void>
}

/** Opens an SSH connection and a local TCP listener forwarding to `targetHost:targetPort`. */
export async function openSshTunnel(ssh: SshConfig, targetHost: string, targetPort: number): Promise<SshTunnel> {
  const client = new Client()
  const connectConfig: ConnectConfig = {
    host: ssh.host,
    port: ssh.port ?? 22,
    username: ssh.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
  }
  if (ssh.authMethod === 'password') connectConfig.password = ssh.password
  if (ssh.authMethod === 'privateKey') {
    connectConfig.privateKey = ssh.privateKey
    if (ssh.passphrase) connectConfig.passphrase = ssh.passphrase
  }
  if (ssh.authMethod === 'agent') {
    connectConfig.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK
  }

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', reject)
    client.connect(connectConfig)
  })

  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, targetHost, targetPort, (err, stream) => {
      if (err) {
        socket.destroy(err)
        return
      }
      socket.pipe(stream).pipe(socket)
      stream.once('close', () => socket.destroy())
      socket.once('error', () => stream.close())
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as net.AddressInfo

  return {
    localHost: '127.0.0.1',
    localPort: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => {
          client.end()
          resolve()
        })
      }),
  }
}
