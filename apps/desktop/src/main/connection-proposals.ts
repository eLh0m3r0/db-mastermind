/**
 * Connections agents propose (MCP propose_connection), kept as files in the app's data folder until the user saves or
 * dismisses them. Files, because the stdio MCP server is a separate process and the app owns the saved connections.
 * Must not import 'electron' (the MCP child uses it).
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connectionProposal, type ConnectionProposal } from '@dbmastermind/core'

export const PROPOSALS_FOLDER = 'connection-proposals'
const FILE = /^[0-9]+-[0-9a-f]{12}\.json$/
/** More than this many waiting is an agent misbehaving: the oldest go. */
const MAX_WAITING = 20

export async function writeProposal(dir: string, proposal: ConnectionProposal): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = `${Date.now()}-${randomBytes(6).toString('hex')}.json`
  const tmp = join(dir, `.${file}.tmp`)
  await writeFile(tmp, JSON.stringify(proposal, null, 2), 'utf8')
  await rename(tmp, join(dir, file))
  const all = (await readdir(dir)).filter((f) => FILE.test(f)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - MAX_WAITING))) await unlink(join(dir, old)).catch(() => {})
  return file
}

/** The proposals waiting, oldest first; a file that doesn't read as a valid proposal is removed. */
export async function listProposals(dir: string): Promise<{ file: string; proposal: ConnectionProposal }[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => FILE.test(f)).sort()
  const out: { file: string; proposal: ConnectionProposal }[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>
      // Validated again: the folder is on disk, anything could have written there.
      const proposal = connectionProposal(raw, typeof raw.proposedBy === 'string' ? raw.proposedBy : undefined, new Date(typeof raw.proposedAt === 'string' ? raw.proposedAt : Date.now()))
      out.push({ file, proposal })
    } catch {
      await unlink(join(dir, file)).catch(() => {})
    }
  }
  return out
}

export async function dismissProposal(dir: string, file: string): Promise<void> {
  if (!FILE.test(file)) throw new Error('Not a proposal')
  await unlink(join(dir, file)).catch(() => {})
}
