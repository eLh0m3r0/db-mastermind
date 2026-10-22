import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { app } from 'electron'
import type { KbLocation, KbTarget, StoredConnection } from '@shared/api'
import * as connections from './connections'
import { team, teamDir } from './team'
import { TEAM_KNOWLEDGE } from './team-folder'

/** Where a connection's notes live when nobody chose a folder: <userData>/knowledge/<name>-<id>. */
export function defaultKnowledgeFolder(config: { id: string; name: string }): string {
  return join(app.getPath('userData'), 'knowledge', `${config.name.replace(/[^\p{L}\p{N}._-]+/gu, '_')}-${config.id.slice(0, 6)}`)
}

const inside = (parent: string, path: string) => {
  const rel = relative(resolve(parent), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && resolve(a) === resolve(b)

/** Markdown notes and team tools in a folder (hidden files don't count). */
function noteCount(dir: string | undefined): number {
  if (!dir || !existsSync(dir)) return 0
  let n = 0
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(join(d, entry.name))
      else if (/\.(md|markdown|sql)$/i.test(entry.name)) n++
    }
  }
  walk(dir)
  return n
}

/** Missing, or nothing in it but hidden files: safe to copy notes into. */
function isEmptyFolder(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).every((name) => name.startsWith('.'))
}

/** The team folder's own knowledge base for a team connection (what everyone else uses). */
function teamKnowledgeOf(id: string): string | undefined {
  return team()?.connections.find((c) => c.id === id)?.knowledgeBasePath
}

export function knowledgeLocation(connectionId: string): KbLocation {
  const config = connections.getConnection(connectionId)
  const path = config.knowledgeBasePath
  const dir = teamDir()
  const place: KbLocation['place'] = !path
    ? 'none'
    : dir && inside(dir, path)
      ? 'team-folder'
      : inside(join(app.getPath('userData'), 'knowledge'), path)
        ? 'this-computer'
        : 'folder'
  const isTeam = !!config.team
  return {
    path,
    place,
    notes: noteCount(path),
    sharedWith: path ? connections.listConnections().filter((c) => c.id !== connectionId && same(c.knowledgeBasePath, path)).map((c) => c.name) : [],
    team: isTeam,
    // A team connection whose knowledge base this user pointed elsewhere (only for them).
    personal: isTeam && !!config.knowledgeBaseLocal,
    teamPath: isTeam ? teamKnowledgeOf(connectionId) : undefined,
    canMoveToTeam: !!dir && place !== 'team-folder',
    isDefault: same(path, defaultKnowledgeFolder(config)),
    defaultPath: defaultKnowledgeFolder(config),
  }
}

export function inspectKnowledgeFolder(path: string): { empty: boolean; notes: number } {
  return { empty: isEmptyFolder(path), notes: noteCount(path) }
}

/**
 * Points a connection's knowledge base somewhere else. Notes are copied only when asked and only into an empty
 * folder (moving to the team folder copies without overwriting, like Add to team folder); the old folder is never
 * deleted. For a team connection a folder other than the team's applies only to this user.
 */
export function setKnowledgeLocation(connectionId: string, target: KbTarget, copy: boolean): KbLocation {
  const config = connections.getConnection(connectionId)
  const current = config.knowledgeBasePath
  let next: string
  switch (target.kind) {
    case 'folder':
      next = target.path
      break
    case 'default':
      next = defaultKnowledgeFolder(config)
      break
    case 'same-as': {
      const other = connections.getConnection(target.connectionId)
      next = other.knowledgeBasePath ?? defaultKnowledgeFolder(other)
      if (!other.knowledgeBasePath) {
        mkdirSync(next, { recursive: true })
        connections.saveConnection({ ...other, knowledgeBasePath: next })
      }
      break
    }
    case 'team': {
      const dir = teamDir()
      if (!dir) throw new Error('Choose a team folder first (Settings → General)')
      next = (config.team && teamKnowledgeOf(connectionId)) || join(dir, TEAM_KNOWLEDGE, connectionId)
      // A team connection just goes back to the team's notes (personal notes aren't pushed to everyone). Otherwise
      // the same as Add to team folder: copy what is here, never overwrite colleagues' notes.
      if (!config.team && current && existsSync(current) && !same(current, next)) cpSync(current, next, { recursive: true, force: false, errorOnExist: false })
      break
    }
  }
  if (target.kind !== 'team' && copy && current && !same(current, next) && existsSync(current) && isEmptyFolder(next)) {
    cpSync(current, next, { recursive: true, force: false, errorOnExist: false })
  }
  mkdirSync(next, { recursive: true })
  const teamPath = config.team ? teamKnowledgeOf(connectionId) : undefined
  const personal = !!config.team && !same(next, teamPath)
  connections.saveConnection({ ...config, knowledgeBasePath: next, knowledgeBaseLocal: personal || undefined } as StoredConnection)
  return knowledgeLocation(connectionId)
}
