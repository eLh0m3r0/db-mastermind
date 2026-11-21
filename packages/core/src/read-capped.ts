import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { megabytes } from './untrusted.js'

/**
 * Reading a file a stranger may have made: only a regular file is read (a FIFO would block, /dev/zero never ends),
 * and reading stops at the limit whatever size the file reports. O_NONBLOCK makes opening a FIFO return at once
 * (the descriptor's type is checked before anything is read); `follow: false` refuses a link (O_NOFOLLOW).
 */
export interface CappedRead {
  /** Bytes at most; one more is an error. */
  limit: number
  /** What the file should have been, for the error ("a model"). */
  what: string
  /** Follow a link (a file the user picked) or refuse it (a file inside a stranger's folder). Default: follow. */
  follow?: boolean
}

const flags = (follow: boolean) => constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (follow ? 0 : (constants.O_NOFOLLOW ?? 0))
const CHUNK = 64 * 1024

export class NotAFileError extends Error {}

const tooLarge = (path: string, o: CappedRead) => new Error(`${basename(path)} is larger than ${megabytes(o.limit)}: not ${o.what} this app opens`)
const notAFile = (path: string, o: CappedRead) => new NotAFileError(`${basename(path)} is not a plain file: not ${o.what} this app opens`)

export function readCappedSync(path: string, o: CappedRead): Buffer {
  let fd: number
  try {
    fd = openSync(path, flags(o.follow ?? true))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw notAFile(path, o)
    throw err
  }
  try {
    if (!fstatSync(fd).isFile()) throw notAFile(path, o)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(CHUNK)
      const n = readSync(fd, chunk, 0, CHUNK, null)
      if (!n) break
      total += n
      if (total > o.limit) throw tooLarge(path, o)
      chunks.push(n === CHUNK ? chunk : chunk.subarray(0, n))
    }
    return Buffer.concat(chunks, total)
  } finally {
    closeSync(fd)
  }
}

export async function readCapped(path: string, o: CappedRead): Promise<Buffer> {
  let handle
  try {
    handle = await open(path, flags(o.follow ?? true))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw notAFile(path, o)
    throw err
  }
  try {
    if (!(await handle.stat()).isFile()) throw notAFile(path, o)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(CHUNK)
      const { bytesRead: n } = await handle.read(chunk, 0, CHUNK, null)
      if (!n) break
      total += n
      if (total > o.limit) throw tooLarge(path, o)
      chunks.push(n === CHUNK ? chunk : chunk.subarray(0, n))
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}
