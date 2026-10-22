import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Button } from '@/components/ui/Button'
import { Checkbox, Field, Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useT } from '@/lib/i18n'

export interface PasswordAnswer {
  value: string
  save: boolean
}

interface Ask {
  title: string
  user?: string
  /** Set when the server rejected the previous password. */
  rejected?: string
  resolve: (answer: PasswordAnswer | null) => void
}

const usePrompt = create<{ ask?: Ask }>(() => ({}))

/** Asks for a connection's password (none saved, or the server rejected it); null when cancelled. */
export function askPassword(title: string, user?: string, rejected?: string): Promise<PasswordAnswer | null> {
  return new Promise((resolve) => usePrompt.setState({ ask: { title, user, rejected, resolve } }))
}

export function PasswordPrompt() {
  const t = useT()
  const ask = usePrompt((s) => s.ask)
  const [value, setValue] = useState('')
  const [save, setSave] = useState(true)
  useEffect(() => setValue(''), [ask])

  const finish = (answer: PasswordAnswer | null) => {
    ask?.resolve(answer)
    usePrompt.setState({ ask: undefined })
  }

  return (
    <Modal
      open={!!ask}
      onClose={() => finish(null)}
      title={ask?.user ? t('Password for {user} on {name}', { user: ask.user, name: ask.title }) : t('Password for {name}', { name: ask?.title ?? '' })}
      width={440}
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" onClick={() => finish(null)}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" disabled={!value} onClick={() => finish({ value, save })}>
            {t('Connect')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (value) finish({ value, save })
        }}
      >
        {ask?.rejected ? (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px]">
            {t('The server rejected the password.')}
            <div className="mt-0.5 text-[11.5px] text-fg-muted">{ask.rejected}</div>
          </div>
        ) : (
          <p className="text-[12.5px] text-fg-muted">{t('No password is saved for this connection.')}</p>
        )}
        <Field label={t('Password')}>
          <Input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Checkbox checked={save} onChange={setSave} label={t('Save password')} hint={t('Stored encrypted with your operating system keychain.')} />
      </form>
    </Modal>
  )
}
