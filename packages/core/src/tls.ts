import net from 'node:net'
import tls from 'node:tls'
import type { SslConfig } from './types.js'

/**
 * Node TLS options for a database connection, or false for none.
 * - prefer / require: encrypt without checking the certificate (prefer also falls back to plain, see `noTlsOnServer`)
 * - verify-ca: the certificate must chain to the CA
 * - verify-full: and name `serverHost` — the real server, also when connecting through an SSH tunnel's 127.0.0.1
 */
export function tlsOptions(ssl: SslConfig | undefined, serverHost: string): false | tls.ConnectionOptions {
  const mode = ssl?.mode ?? 'disable'
  if (mode === 'disable') return false
  const verify = mode === 'verify-ca' || mode === 'verify-full'
  return {
    rejectUnauthorized: verify,
    ca: ssl?.ca || undefined,
    cert: ssl?.cert || undefined,
    key: ssl?.key || undefined,
    servername: net.isIP(serverHost) ? undefined : serverHost,
    checkServerIdentity:
      mode === 'verify-full' ? (_host, cert) => tls.checkServerIdentity(serverHost, cert) : () => undefined,
  }
}

/** The server refused TLS: with "prefer" the driver connects again without it (as libpq does). */
export function noTlsOnServer(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return (
    e?.code === 'HANDSHAKE_NO_SSL_SUPPORT' ||
    /does not support SSL|does not support secure connection/i.test(e?.message ?? '')
  )
}
