/**
 * What a failed connection attempt means and what to do about it, from the driver's own message (pg, mysql2,
 * mssql, sockets). The driver's text stays available as the detail; `summary` is undefined when nothing better
 * than the driver's text is known.
 */
export type Translate = (text: string, vars?: Record<string, string>) => string

export interface ConnectProblem {
  summary?: string
  /** The driver's own words, shown under the summary. */
  detail: string
  /** Which part of the form fixes it, when one does. */
  section?: 'general' | 'ssl' | 'ssh'
}

export function explainConnectError(message: string, t: Translate): ConnectProblem {
  const detail = message.trim()
  const m = (re: RegExp) => re.exec(detail)
  let hit: RegExpExecArray | null
  if ((hit = m(/ECONNREFUSED\s+(\[?[\w.:-]+\]?:\d+)/)) || (hit = m(/Failed to connect to (\S+?:\d+) - Could not connect/))) {
    return { summary: t('Nothing is listening on {address}. Is the database running, and are the host and port right?', { address: hit[1]! }), detail, section: 'general' }
  }
  if ((hit = m(/(?:ENOTFOUND|EAI_AGAIN)\s+([\w.-]+)/))) {
    return { summary: t('The host name {host} can’t be found. Check its spelling, or connect to the VPN first.', { host: hit[1]! }), detail, section: 'general' }
  }
  if ((hit = m(/(?:EHOSTUNREACH|ENETUNREACH)\s+(\S+)/))) {
    return { summary: t('The network can’t reach {address}. Are you online, or does it need the VPN?', { address: hit[1]! }), detail, section: 'general' }
  }
  if (/ETIMEDOUT|timed? ?out|timeout expired|connection timeout|Failed to connect to \S+ in \d+ms/i.test(detail)) {
    return { summary: t('The server didn’t answer in time. A firewall or VPN may be in the way; an SSH tunnel can help.'), detail, section: 'ssh' }
  }
  if (/password authentication failed|Access denied for user|Login failed for user|authentication failed|invalid username\/password|ORA-01017/i.test(detail)) {
    return { summary: t('The server rejected the user name or password.'), detail, section: 'general' }
  }
  if ((hit = m(/database "([^"]+)" does not exist/)) || (hit = m(/Unknown database '([^']+)'/)) || (hit = m(/Cannot open database "([^"]+)"/))) {
    return { summary: t('There is no database {name} on this server. Check the Database field.', { name: hit[1]! }), detail, section: 'general' }
  }
  if (/does not support SSL|SSL is not enabled|self[- ]signed certificate|unable to verify the first certificate|certificate has expired|Hostname\/IP does not match|ERR_TLS|SSL routines|wrong version number/i.test(detail)) {
    return { summary: t('The TLS settings don’t match the server. Check the SSL / TLS tab.'), detail, section: 'ssl' }
  }
  return { detail }
}
