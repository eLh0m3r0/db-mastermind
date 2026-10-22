import { useCallback, useEffect, useState } from 'react'
import { Copy, FolderInput, FolderOpen, HardDrive, Home, Link2, Users } from 'lucide-react'
import type { KbLocation, KbTarget, StoredConnection } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { openMenu, type MenuItem } from '@/components/ui/ContextMenu'
import { askChoice, confirmAction } from '@/components/ui/ConfirmDialog'
import { api, isMac } from '@/lib/api'
import { t, tp, useT } from '@/lib/i18n'
import { errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast } from '@/store/ui'

/** The folder's own name ("…/crm-notes"); the full path goes in a tooltip. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? `…/${parts[parts.length - 1]}` : path
}

export function placeLabel(location: KbLocation): string {
  if (location.place === 'team-folder') return t('Team folder')
  if (location.place === 'this-computer') return t('This computer')
  if (location.place === 'folder' && location.path) return shortPath(location.path)
  return t('Not set up yet')
}

export function useKnowledgeLocation(connectionId: string | undefined, path: string | undefined) {
  const [location, setLocation] = useState<KbLocation>()
  const reload = useCallback(() => {
    if (!connectionId) return setLocation(undefined)
    api.kbLocation(connectionId).then(setLocation, () => setLocation(undefined))
  }, [connectionId])
  // The connection's path changes when it is moved (here or in the connection form).
  useEffect(reload, [reload, path])
  return { location, reload }
}

/** A team connection pointed elsewhere only changes it for this user: say so first. */
async function personalOk(connection: StoredConnection, location: KbLocation): Promise<boolean> {
  if (!location.team) return true
  return confirmAction({
    title: t('Use another folder only for you?'),
    message: t('{name} comes from the team folder. Colleagues keep using the team’s knowledge base; your notes in the other folder stay yours. You can go back to the team’s any time.', { name: connection.name }),
    confirmLabel: t('Use it for me'),
  })
}

async function apply(connection: StoredConnection, target: KbTarget, copy: boolean, done: (l: KbLocation) => void) {
  try {
    const location = await api.kbSetLocation(connection.id, target, copy)
    await useConnections.getState().load()
    done(location)
    toast({ kind: 'success', message: t('Knowledge base: {place}', { place: placeLabel(location) }), detail: location.path })
  } catch (err) {
    toast({ kind: 'error', message: t('Could not change the knowledge base folder'), detail: errorMessage(err) })
  }
}

/** Copy the current notes into an empty target? Null when cancelled. */
async function askCopy(location: KbLocation, target: string): Promise<boolean | null> {
  if (!location.notes) return false
  const info = await api.kbInspectFolder(target)
  if (!info.empty) return false
  const choice = await askChoice({
    title: t('Copy the notes into the new folder?'),
    message: tp(location.notes, {
      one: 'The folder is empty. {n} note can be copied there; the current folder stays as it is.',
      many: 'The folder is empty. {n} notes can be copied there; the current folder stays as it is.',
    }),
    confirmLabel: t('Copy notes'),
    secondaryLabel: t('Use it empty'),
  })
  return choice === null ? null : choice === 'confirm'
}

/**
 * Where else the knowledge base can live: a chosen folder (a project's Git repository), the same folder as another
 * connection (dev/test/prod of one project), the team folder, or back to this computer. Used by the knowledge base
 * header and the connection form.
 */
export function openLocationMenu(anchor: HTMLElement, connection: StoredConnection, location: KbLocation, done: (l: KbLocation) => void) {
  const others = useConnections.getState().list.filter((c) => c.id !== connection.id && !(location.path && c.knowledgeBasePath === location.path))
  const items: MenuItem[] = [
    {
      label: t('Choose folder…'),
      icon: <FolderInput size={13} />,
      onClick: async () => {
        const dir = await api.pickDirectory(t('Knowledge base folder'))
        if (!dir || !(await personalOk(connection, location))) return
        const copy = await askCopy(location, dir)
        if (copy === null) return
        await apply(connection, { kind: 'folder', path: dir }, copy, done)
      },
    },
    {
      label: t('Use the same as…'),
      icon: <Link2 size={13} />,
      disabled: !others.length,
      submenu: others.map((c) => ({
        label: c.name,
        onClick: async () => {
          if (await personalOk(connection, location)) await apply(connection, { kind: 'same-as', connectionId: c.id }, false, done)
        },
      })),
    },
  ]
  if (location.team && location.personal) {
    items.push({ label: t('Use the team’s knowledge base'), icon: <Users size={13} />, onClick: () => void apply(connection, { kind: 'team' }, false, done) })
  } else if (!location.team && location.canMoveToTeam) {
    items.push({
      label: t('Move to the team folder'),
      icon: <Users size={13} />,
      onClick: async () => {
        const ok = await confirmAction({
          title: t('Move the knowledge base to the team folder?'),
          message: t('The notes are copied into the team folder (existing files there are kept) and this connection uses them from there. The current folder stays as it is.'),
          confirmLabel: t('Copy to team folder'),
        })
        if (ok) await apply(connection, { kind: 'team' }, true, done)
      },
    })
  }
  if (!location.team && !location.isDefault) {
    items.push({
      label: t('Back to this computer'),
      icon: <Home size={13} />,
      onClick: async () => {
        const copy = await askCopy(location, location.defaultPath)
        if (copy !== null) await apply(connection, { kind: 'default' }, copy, done)
      },
    })
  }
  if (location.path) {
    items.push('separator', {
      label: isMac ? t('Show in Finder') : t('Show in Explorer'),
      icon: <FolderOpen size={13} />,
      onClick: () => void api.showItemInFolder(location.path!),
    })
  }
  openMenu(anchor, items)
}

/** Where the notes live, who else uses them, and Change…: the knowledge base header and the connection form. */
export function KnowledgeLocationBar({ connection, location, onChanged, compact }: { connection: StoredConnection; location: KbLocation; onChanged: (l: KbLocation) => void; compact?: boolean }) {
  const t = useT()
  const icon = location.place === 'team-folder' ? <Users size={12} /> : location.place === 'this-computer' ? <HardDrive size={12} /> : <FolderOpen size={12} />
  return (
    <div className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-1 border-b border-line px-3 py-2'}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
        <span className="shrink-0 text-fg-faint">{icon}</span>
        <span className="min-w-0 truncate font-medium" title={location.path}>
          {placeLabel(location)}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            const anchor = e.currentTarget
            // Fresh numbers: notes may have been added since the header loaded (the copy offer depends on them).
            void api.kbLocation(connection.id).then((fresh) => openLocationMenu(anchor, connection, fresh, onChanged), () => openLocationMenu(anchor, connection, location, onChanged))
          }}
        >
          {t('Change…')}
        </Button>
      </div>
      {location.team && (
        <div className="text-[11px] text-fg-faint">
          {location.personal ? t('Only for you: colleagues use the team’s knowledge base.') : t('Shared through the team folder.')}
        </div>
      )}
      {location.sharedWith.length > 0 && (
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-fg-faint" title={location.sharedWith.join(', ')}>
          <Copy size={11} className="shrink-0" />
          <span className="truncate">{t('Also used by {names}', { names: location.sharedWith.join(', ') })}</span>
        </div>
      )}
    </div>
  )
}
