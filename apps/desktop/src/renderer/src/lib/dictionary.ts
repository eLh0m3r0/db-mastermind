import { api } from '@/lib/api'
import { t } from '@/lib/i18n'
import { errorMessage } from '@/lib/utils'
import { toast } from '@/store/ui'

/** Asks where to save, writes the data dictionary and offers to reveal the file. */
export async function exportDataDictionary(connectionId: string, format: 'html' | 'markdown', schemas?: string[]): Promise<void> {
  try {
    const path = await api.exportDataDictionary(connectionId, format, schemas)
    if (path) toast({ kind: 'success', message: t('Data dictionary saved'), detail: path, action: { label: t('Show in folder'), run: () => void api.showItemInFolder(path) } })
  } catch (err) {
    toast({ kind: 'error', message: t('Could not create the data dictionary'), detail: errorMessage(err) })
  }
}
