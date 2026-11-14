import { runDbm } from './dbm.js'

const code = await runDbm(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) })
// Let stdout drain (large exports piped elsewhere) before exiting.
process.stdout.write('', () => process.exit(code))
