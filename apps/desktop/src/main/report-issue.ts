import { release } from 'node:os'
import { app } from 'electron'

/** The OS as people name it: "macOS 15.2", "Windows 10.0.26100", "Linux 6.8.0". */
function systemName(): string {
  const version = process.getSystemVersion?.() || release()
  const name = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
  return `${name} ${version} (${process.arch})`
}

/** GitHub's bug form (.github/ISSUE_TEMPLATE/bug.yml) with the app version and OS filled in. */
export function reportIssueUrl(): string {
  const params = new URLSearchParams({ template: 'bug.yml', version: app.getVersion(), os: systemName() })
  return `https://github.com/eLh0m3r0/db-mastermind/issues/new?${params}`
}
