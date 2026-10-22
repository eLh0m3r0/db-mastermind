import { Fragment, type ReactNode } from 'react'
import { Check, Copy, CornerDownLeft, Play } from 'lucide-react'
import { useState } from 'react'
import { copyText } from '@/lib/utils'
import { useT } from '@/lib/i18n'

export interface CodeActions {
  onInsert?: (code: string) => void
  onRun?: (code: string) => void
  /** DBML blocks: replace the open model with this one. */
  onApplyModel?: (code: string) => void
  /** DBML blocks while an ER diagram is open: load the tables into the schema designer as pending changes. */
  onApplyDesign?: (code: string) => void
}

/** Inline markdown: **bold**, *italic*, `code`, [links](url). Produces React nodes, never HTML. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-${i++}`
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={key} className="rounded bg-muted px-1 py-px font-mono text-[11.5px]">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!
      out.push(
        <a key={key} href={lm[2]} target="_blank" rel="noreferrer" className="text-accent underline">
          {lm[1]}
        </a>,
      )
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ code, lang, actions }: { code: string; lang: string; actions: CodeActions }) {
  const [copied, setCopied] = useState(false)
  const t = useT()
  const isSql = /^(sql|pgsql|postgres|postgresql|tsql|mysql|sqlite)?$/i.test(lang) && /\b(select|insert|update|delete|with|create|alter)\b/i.test(code)
  return (
    <div className="my-2 overflow-hidden rounded-md border border-line bg-subtle">
      <div className="flex h-7 items-center gap-1 border-b border-line px-2 text-[11px] text-fg-faint">
        <span className="flex-1">{lang || t('code')}</span>
        {/^dbml$/i.test(lang) && actions.onApplyDesign && (
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={() => actions.onApplyDesign!(code)}>
            <CornerDownLeft size={11} /> {t('Apply to design')}
          </button>
        )}
        {/^dbml$/i.test(lang) && actions.onApplyModel && !actions.onApplyDesign && (
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={() => actions.onApplyModel!(code)}>
            <CornerDownLeft size={11} /> {t('Apply to model')}
          </button>
        )}
        {isSql && actions.onInsert && (
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg" onClick={() => actions.onInsert!(code)}>
            <CornerDownLeft size={11} /> {t('Insert')}
          </button>
        )}
        {isSql && actions.onRun && (
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft" onClick={() => actions.onRun!(code)}>
            <Play size={11} /> {t('Run')}
          </button>
        )}
        <button
          type="button"
          title={t('Copy')}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg"
          onClick={() => {
            void copyText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      <pre className="overflow-auto p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre select-text">{code}</pre>
    </div>
  )
}

function Table({ lines, keyPrefix }: { lines: string[]; keyPrefix: string }) {
  const rows = lines.filter((l, i) => !(i === 1 && /^\s*\|?\s*:?-{2,}/.test(l))).map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
  const [head, ...body] = rows
  return (
    <div className="my-2 overflow-auto rounded-md border border-line">
      <table className="w-full border-collapse text-[11.5px]">
        <thead className="bg-subtle">
          <tr>
            {head?.map((c, i) => (
              <th key={i} className="border-b border-line px-2 py-1 text-left font-semibold">
                {inline(c, `${keyPrefix}h${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} className="border-b border-line px-2 py-1 align-top">
                  {inline(c, `${keyPrefix}${ri}.${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Markdown({ text, actions = {} }: { text: string; actions?: CodeActions }) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = /^\s*```(\w*)/.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!)
      i++
      blocks.push(<CodeBlock key={k++} code={code.join('\n')} lang={fence[1] ?? ''} actions={actions} />)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const tableLines: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) tableLines.push(lines[i++]!)
      blocks.push(<Table key={k++} lines={tableLines} keyPrefix={`t${k}`} />)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        <div key={k++} className="mt-2 mb-1 text-[13px] font-semibold">
          {inline(heading[2]!, `h${k}`)}
        </div>,
      )
      i++
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = []
      const ordered = /^\s*\d+\./.test(line)
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ''))
      const List = ordered ? 'ol' : 'ul'
      blocks.push(
        <List key={k++} className={`my-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'}`}>
          {items.map((it, j) => (
            <li key={j} className="my-0.5">
              {inline(it, `l${k}.${j}`)}
            </li>
          ))}
        </List>,
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+\.\s|\|)/.test(lines[i]!)) para.push(lines[i++]!)
    if (para.length === 0) {
      // A line that looked like a block start but wasn't one: render as text.
      para.push(lines[i++]!)
    }
    blocks.push(
      <p key={k++} className="my-1.5">
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `p${k}.${j}`)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return <div className="text-[12.5px] leading-relaxed break-words select-text">{blocks}</div>
}
