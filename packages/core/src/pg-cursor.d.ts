declare module 'pg-cursor' {
  import type { QueryArrayResult, Submittable } from 'pg'

  interface CursorConfig {
    rowMode?: 'array'
    types?: unknown
  }

  export default class Cursor implements Submittable {
    constructor(text: string, values?: unknown[], config?: CursorConfig)
    submit: Submittable['submit']
    read(rows: number, cb: (err: Error | undefined, rows: unknown[][], result: QueryArrayResult) => void): void
    close(): Promise<void>
  }
}
