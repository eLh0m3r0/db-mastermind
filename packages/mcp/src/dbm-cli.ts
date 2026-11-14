import { once } from 'node:events'
import { runDbm } from './dbm.js'

// stdout.write returns false when the pipe is full: wait for it to drain before the next rows are fetched.
const code = await runDbm(process.argv.slice(2), {
  stdout: (text) => (process.stdout.write(text) ? undefined : once(process.stdout, 'drain').then(() => undefined)),
  stderr: (text) => void process.stderr.write(text),
})
process.stdout.write('', () => process.exit(code))
