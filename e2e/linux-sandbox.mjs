// Linux: does a packaged build start, and is its renderer really inside Chromium's sandbox?
//
//   node e2e/linux-sandbox.mjs <executable> sandboxed|fallback|refused [--plain]
//
// <executable> is the installed .deb's binary, an .AppImage, or a .desktop file whose Exec line is started as it is
// (with --plain; that is what the menu launcher runs). The answer comes from the running processes, not from
// the command line: a sandboxed renderer runs under a seccomp-bpf filter (`Seccomp: 2` in /proc/<pid>/status) inside
// its own PID namespace (two numbers in `NSpid`); with --no-sandbox it has neither. chrome://sandbox, Chromium's own
// report, is printed as well when Electron serves it.
//
// Default: launched through Playwright (with chromiumSandbox: true, or Playwright itself adds --no-sandbox) with a
// model file as its argument, which must open in a tab. --plain: started with no arguments at all, the way
// electron-updater starts a replaced AppImage after an update, and watched from outside.
// "refused": the system offers Chromium no sandbox at all (no user namespaces for users, no SUID helper); the app must
// stop with Chromium's sandbox error rather than run unsandboxed. Always a plain start.
// "fallback" with --plain also expects the one stderr line that explains why the AppImage runs without the sandbox
// (only a plain start reads stderr from its first byte).
import { _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [exe, expect, mode] = process.argv.slice(2)
if (!exe || !['sandboxed', 'fallback', 'refused'].includes(expect)) {
  console.error('usage: node e2e/linux-sandbox.mjs <executable> sandboxed|fallback|refused [--plain]')
  process.exit(2)
}
const dir = mkdtempSync(join(tmpdir(), 'dbm-sandbox-'))
const env = { ...process.env, HOME: dir, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' }
const SANDBOX_LINE = /running without Chromium's sandbox/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const problems = []

function processes() {
  const list = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8')
      const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim() ?? ''
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ')
      list.push({ pid: Number(name), ppid: Number(field('PPid')), seccomp: field('Seccomp'), nspid: field('NSpid').split(/\s+/), cmdline })
    } catch {
      // The process ended while we looked.
    }
  }
  return list
}

/** Renderers among the descendants of `root` (the AppImage runtime, AppRun or the app itself). */
function renderers(root) {
  const all = processes()
  const tree = new Set([root])
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all) if (!tree.has(p.pid) && tree.has(p.ppid)) (tree.add(p.pid), (grew = true))
  }
  return all.filter((p) => tree.has(p.pid) && p.cmdline.includes('--type=renderer'))
}

function judge(list) {
  if (list.length === 0) return problems.push('no renderer process found')
  for (const r of list) {
    const sandboxed = r.seccomp === '2' && r.nspid.length > 1
    console.log(`renderer ${r.pid}: Seccomp ${r.seccomp}, NSpid ${r.nspid.join(' ')} → ${sandboxed ? 'sandboxed' : 'not sandboxed'}`)
    if (expect === 'sandboxed' && !sandboxed) problems.push(`renderer ${r.pid} is not sandboxed`)
    if (expect === 'fallback' && sandboxed) problems.push(`renderer ${r.pid} is sandboxed, the fallback was expected`)
  }
}

/** `complete`: stderr was read from the very start (Playwright hands it over only after the app has started). */
function judgeStderr(stderr, complete) {
  const line = stderr.split('\n').find((l) => SANDBOX_LINE.test(l))
  if (line) console.log(`stderr: ${line}`)
  // The AppImage says why on stderr; the .deb said so when it was installed.
  if (complete && expect === 'fallback' && exe.endsWith('.AppImage') && !line) problems.push('no stderr line explaining the missing sandbox')
  if (expect === 'sandboxed' && line) problems.push('the missing-sandbox line was printed although the sandbox is on')
  if (/FATAL|SUID sandbox helper/.test(stderr)) problems.push(`Chromium complained:\n${stderr.split('\n').filter((l) => /FATAL|sandbox/i.test(l)).join('\n')}`)
}

if (expect === 'refused') {
  const child = spawn(exe, [], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const code = await Promise.race([new Promise((r) => child.once('exit', (c, sig) => r(c ?? sig))), sleep(30_000).then(() => 'still running')])
  const line = stderr.split('\n').find((l) => /sandbox/i.test(l))
  console.log(`exit: ${code}${line ? `\nstderr: ${line.trim()}` : ''}`)
  if (code === 'still running') {
    problems.push(`started although no sandbox is possible: renderers ${JSON.stringify(renderers(child.pid).map((r) => [r.seccomp, r.nspid]))}`)
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  } else if (!line) problems.push(`exited (${code}) without a sandbox error:\n${stderr}`)
} else if (mode === '--plain') {
  // A .desktop file: its Exec line, quoted words kept together, field codes (%U) dropped.
  let [command, ...args] = [exe, ...[]]
  if (exe.endsWith('.desktop')) {
    const execLine = /^Exec=(.*)$/m.exec(readFileSync(exe, 'utf8'))?.[1] ?? ''
    console.log(`Exec=${execLine}`)
    ;[command, ...args] = [...execLine.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((w) => !/^%[fFuU]$/.test(w))
  }
  // The process group is killed at the end: the AppImage runtime, the app and its helpers.
  const child = spawn(command, args, { env: { ...env, APPIMAGE_SILENT_INSTALL: 'true' }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  let found = []
  for (let i = 0; i < 60 && found.length === 0; i++) {
    await sleep(1000)
    if (child.exitCode !== null) break
    found = renderers(child.pid)
  }
  await sleep(2000)
  if (child.exitCode !== null) problems.push(`exited with ${child.exitCode}:\n${stderr}`)
  judge(renderers(child.pid))
  judgeStderr(stderr, true)
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
} else {
  const model = join(dir, 'sandbox-check.dbml')
  writeFileSync(model, 'Table sandbox_probe {\n  id integer [pk]\n  name varchar\n}\n')
  const app = await electron.launch({ executablePath: exe, args: [model], env, chromiumSandbox: true, timeout: 90_000 })
  let stderr = ''
  app.process().stderr?.on('data', (d) => (stderr += d))
  try {
    const win = await app.firstWindow()
    await win.getByText('sandbox-check').first().waitFor({ timeout: 30_000 })
    console.log('window open, the model file opened in a tab')
    // The window is created hidden and shown on ready-to-show, which can come after the page has rendered.
    let main
    for (let i = 0; i < 30; i++) {
      main = await app.evaluate(({ app: a, BrowserWindow }) => ({
        noSandboxSwitch: a.commandLine.hasSwitch('no-sandbox'),
        appImage: process.env.APPIMAGE ?? null,
        windows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
      }))
      if (main.windows > 0) break
      await sleep(1000)
    }
    console.log(`main process: ${JSON.stringify(main)}`)
    if (main.windows < 1) problems.push('no visible window')
    if (exe.endsWith('.AppImage') && main.appImage !== exe) problems.push(`APPIMAGE is ${main.appImage}, the updater and the MCP path need ${exe}`)
    if (expect === 'sandboxed' && main.noSandboxSwitch) problems.push('started with --no-sandbox')
    if (expect === 'fallback' && !main.noSandboxSwitch) problems.push('the fallback should have added --no-sandbox')
    judge(renderers(app.process().pid))
    // Chromium's own report; Electron may not serve this page, which is not a failure.
    const report = await app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ show: false })
      try {
        const loaded = w.loadURL('chrome://sandbox').then(() => w.webContents.executeJavaScript('document.body.innerText'))
        return await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 10_000))])
      } catch (err) {
        return `(not available: ${err.message})`
      } finally {
        w.destroy()
      }
    })
    console.log(`chrome://sandbox: ${report.replace(/\s+/g, ' ').slice(0, 600)}`)
    if (/You are adequately sandboxed/.test(report) && expect === 'fallback') problems.push('chrome://sandbox says sandboxed, the fallback was expected')
    if (/You are not adequately sandboxed/.test(report) && expect === 'sandboxed') problems.push('chrome://sandbox says not adequately sandboxed')
  } catch (err) {
    problems.push(`${err.message.split('\n')[0]}\n${stderr}`)
  } finally {
    await app.close().catch(() => {})
  }
  judgeStderr(stderr, false)
}

if (problems.length) {
  console.error(`LINUX SANDBOX CHECK FAILED (${expect}${mode ? ' ' + mode : ''}):\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`LINUX SANDBOX OK (${expect}${mode ? ' ' + mode : ''})`)
process.exit(0)
