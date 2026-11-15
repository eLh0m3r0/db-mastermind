import { Kbd } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { keys } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { appShortcuts } from '@/lib/keymap'
import { useUi } from '@/store/ui'

/** What each app-wide command is called here (every command in the keymap needs one: ui-coverage.test.ts). */
export const SHORTCUT_LABELS: Record<string, { group: 'general' | 'query'; label: string }> = {
  palette: { group: 'general', label: 'Command palette' },
  'quick-open': { group: 'general', label: 'Open table' },
  'new-query': { group: 'general', label: 'New query tab' },
  'new-connection': { group: 'general', label: 'New connection…' },
  'open-sql-file': { group: 'general', label: 'Open SQL file…' },
  'open-model': { group: 'general', label: 'Open model…' },
  'close-tab': { group: 'general', label: 'Close tab' },
  'reopen-tab': { group: 'general', label: 'Reopen closed tab' },
  'split-view': { group: 'general', label: 'Split view: open the current tab to the side' },
  'toggle-sidebar': { group: 'general', label: 'Toggle sidebar' },
  'toggle-ai': { group: 'general', label: 'Toggle AI assistant' },
  history: { group: 'general', label: 'History' },
  'refresh-schema': { group: 'general', label: 'Refresh schema' },
  settings: { group: 'general', label: 'Settings…' },
  'run-current': { group: 'query', label: 'Run statement or selection' },
  'run-all': { group: 'query', label: 'Run whole script' },
  'cancel-query': { group: 'query', label: 'Cancel query' },
  'format-sql': { group: 'query', label: 'Format SQL' },
  'save-query': { group: 'query', label: 'Save query' },
  'ask-ai': { group: 'query', label: 'Ask AI' },
  export: { group: 'query', label: 'Export results' },
  'commit-transaction': { group: 'query', label: 'Commit' },
  'rollback-transaction': { group: 'query', label: 'Roll back' },
}

/** Help → Keyboard Shortcuts: read from the keymap itself, so it never lists a key that does something else. */
export function ShortcutsModal() {
  const t = useT()
  const open = useUi((s) => s.modal?.kind === 'shortcuts')
  const setUi = useUi((s) => s.set)
  const all = appShortcuts().filter((s) => SHORTCUT_LABELS[s.command])
  const rows = (group: 'general' | 'query') => all.filter((s) => SHORTCUT_LABELS[s.command]!.group === group).map((s) => ({ keys: keys(s.mac), label: t(SHORTCUT_LABELS[s.command]!.label) }))
  const sections = [
    {
      title: t('General'),
      rows: [...rows('general'), { keys: `${keys('⌘1')} … ${keys('⌘9')}`, label: t('Go to tab 1–9') }, { keys: 'Ctrl+Tab', label: t('Next tab') }],
    },
    { title: t('SQL editor'), rows: [...rows('query'), { keys: `${keys('⌘')}-${t('click')}`, label: t("Open a table's structure or a routine's definition") }] },
    {
      title: t('Table'),
      rows: [
        { keys: keys('⌘S'), label: t('Review and save changes') },
        { keys: keys('⌘R'), label: t('Reload') },
        { keys: keys('⌘F'), label: t('Filter') },
        { keys: keys('⇧↵'), label: t('Edit the cell in a larger editor') },
      ],
    },
  ]
  return (
    <Modal open={open} onClose={() => setUi({ modal: undefined })} title={t('Keyboard shortcuts')} width={620}>
      <div className="grid gap-5 sm:grid-cols-2">
        {sections.map((section) => (
          <section key={section.title} className={section.title === t('General') ? 'sm:row-span-2' : undefined}>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{section.title}</h3>
            <dl className="space-y-1">
              {section.rows.map((r) => (
                <div key={r.label} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <dt className="min-w-0 text-fg-muted">{r.label}</dt>
                  <dd className="shrink-0">
                    <Kbd>{r.keys}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}
