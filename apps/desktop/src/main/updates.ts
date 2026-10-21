import { app } from 'electron'

const RELEASES_API = 'https://api.github.com/repos/eLh0m3r0/db-mastermind/releases/latest'

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

/**
 * Builds are unsigned, so silent auto-update isn't possible on macOS and would break portable installs.
 * Instead the app checks GitHub Releases and offers a download link.
 */
export async function checkForUpdates(notify: (info: { version: string; url: string }) => void): Promise<void> {
  if (!app.isPackaged || process.env.DBM_NO_UPDATE_CHECK) return
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
    if (!release.tag_name || release.draft || release.prerelease) return
    if (newer(release.tag_name, app.getVersion())) {
      notify({ version: release.tag_name.replace(/^v/, ''), url: release.html_url ?? 'https://github.com/eLh0m3r0/db-mastermind/releases' })
    }
  } catch {
    // Offline or rate limited: try again next launch.
  }
}
