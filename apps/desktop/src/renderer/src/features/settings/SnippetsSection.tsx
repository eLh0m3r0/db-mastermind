import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Snippet } from '@shared/api'
import { Button, IconButton } from '@/components/ui/Button'
import { Input, Textarea } from '@/components/ui/Input'
import { useT } from '@/lib/i18n'
import { debounce } from '@/lib/utils'
import { useSettings } from '@/store/settings'
import { builtinSnippets } from '../query/snippets'

const save = debounce((snippets: Snippet[]) => void useSettings.getState().update({ snippets }), 400)

/** Settings → Snippets: user snippets (editable) and the built-ins they can override. */
export function SnippetsSection() {
  const t = useT()
  const stored = useSettings((s) => s.settings?.snippets)
  const [list, setList] = useState<Snippet[]>(stored ?? [])
  useEffect(() => setList(stored ?? []), [stored])
  const change = (next: Snippet[]) => {
    setList(next)
    save(next)
  }
  const builtins = builtinSnippets('postgres')

  return (
    <>
      <p className="text-[12.5px] text-fg-muted">
        {t('Type a trigger in the SQL editor and pick it from the suggestions; Tab jumps between the ${fields}.')}
      </p>
      <div className="flex flex-col gap-3">
        {list.map((s, i) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-md border border-line p-2.5">
            <div className="flex gap-2">
              <Input inputSize="sm" className="w-28 font-mono" placeholder={t('trigger')} value={s.trigger} onChange={(e) => change(list.map((x, j) => (j === i ? { ...x, trigger: e.target.value.replace(/\s/g, '') } : x)))} />
              <Input inputSize="sm" className="flex-1" placeholder={t('Description')} value={s.name} onChange={(e) => change(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <IconButton label={t('Delete')} onClick={() => change(list.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </IconButton>
            </div>
            <Textarea
              rows={3}
              className="font-mono text-[12px]"
              placeholder="SELECT * FROM ${table} WHERE ${condition}"
              value={s.body}
              onChange={(e) => change(list.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
            />
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => change([...list, { trigger: '', name: '', body: '' }])}>
            {t('Add snippet')}
          </Button>
        </div>
      </div>
      <div>
        <h3 className="mb-1.5 text-[12px] font-semibold text-fg-muted">{t('Built-in')}</h3>
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-[12.5px]">
          {builtins.map((b) => (
            <div key={b.trigger} className="contents">
              <code className="font-mono text-accent">{b.trigger}</code>
              <span className="truncate text-fg-muted">{t(b.name)}</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={list.some((x) => x.trigger === b.trigger)}
                onClick={() => change([...list, { ...b, name: t(b.name) }])}
              >
                {t('Customize')}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
