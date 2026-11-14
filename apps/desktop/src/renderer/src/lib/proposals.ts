import { proposalDraft } from '@dbmastermind/core/browser'
import { api, bridge } from '@/lib/api'
import { t } from '@/lib/i18n'
import { dismissToast, toast, useUi } from '@/store/ui'

/** Proposals already shown, by file, with their notice. */
const shown = new Map<string, number>()

/**
 * Connections agents proposed (MCP propose_connection): each shows once as a notice with "Review…", which opens the
 * ordinary connection form prefilled and read-only; ✕ dismisses the proposal for good.
 */
export async function showConnectionProposals(): Promise<void> {
  const list = await api.listConnectionProposals().catch(() => [])
  const waiting = new Set(list.map((x) => x.file))
  // Saved or dismissed elsewhere: its notice goes.
  for (const [file, id] of shown) {
    if (!waiting.has(file)) {
      dismissToast(id)
      shown.delete(file)
    }
  }
  for (const { file, proposal } of list) {
    if (shown.has(file)) continue
    const where = proposal.filePath ?? `${proposal.host ?? ''}${proposal.port ? `:${proposal.port}` : ''}${proposal.database ? `/${proposal.database}` : ''}`
    const id = toast({
      kind: 'info',
      message: proposal.proposedBy ? t('{agent} proposes a connection: {name}', { agent: proposal.proposedBy, name: proposal.name }) : t('An agent proposes a connection: {name}', { name: proposal.name }),
      detail: `${proposal.driver} · ${where}${proposal.user ? ` · ${proposal.user}` : ''}`,
      duration: 0,
      action: {
        label: t('Review…'),
        run: () => {
          // Shown again if the form is closed without saving (see the connection form's close).
          shown.delete(file)
          useUi.getState().set({ modal: { kind: 'connection', draft: proposalDraft(proposal), proposal: file } })
        },
      },
      onDismiss: () => void api.dismissConnectionProposal(file),
    })
    shown.set(file, id)
  }
}

export function listenForConnectionProposals(): () => void {
  void showConnectionProposals()
  return bridge.on('connection:proposals', () => void showConnectionProposals())
}
