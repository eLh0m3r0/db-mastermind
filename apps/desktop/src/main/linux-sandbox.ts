import { spawnSync } from 'node:child_process'
import { app } from 'electron'
import { isMcpMode } from './mcp-mode'

/**
 * The AppImage's launcher (electron-builder's AppRun) adds --no-sandbox when `unshare -Ur true` fails: an AppImage
 * can't carry the SUID sandbox helper, and Ubuntu 23.10 and later let only programs with an AppArmor profile create
 * user namespaces. Say so once on stderr, with the way out, rather than run without the sandbox silently. Nothing is
 * said when namespaces work (the flag was given on purpose) or in --mcp mode, which never opens a window.
 */
export function explainMissingSandbox(): void {
  if (process.platform !== 'linux' || !process.env.APPIMAGE || isMcpMode || !app.commandLine.hasSwitch('no-sandbox')) return
  if (spawnSync('unshare', ['-Ur', 'true'], { stdio: 'ignore' }).status === 0) return
  process.stderr.write(
    "DB Mastermind: running without Chromium's sandbox because this system doesn't let applications create user namespaces (Ubuntu 23.10 and later restrict them). To run it sandboxed, install the .deb package, or allow them with: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\n",
  )
}
