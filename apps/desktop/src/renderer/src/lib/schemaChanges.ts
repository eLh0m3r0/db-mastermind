import type { SchemaChange } from '@dbmastermind/core/browser'
import type { useT } from '@/lib/i18n'

/** One line for a schema change in lists (compare, migration review), with whether it adds, drops or edits. */
export function describeChange(c: SchemaChange, t: ReturnType<typeof useT>): { icon: 'add' | 'drop' | 'edit'; text: string } {
  switch (c.kind) {
    case 'create_table':
      return { icon: 'add', text: t('Create table') }
    case 'drop_table':
      return { icon: 'drop', text: t('Drop table') }
    case 'add_column':
      return { icon: 'add', text: `${t('Add column')} ${c.column.name} ${c.column.dataType}` }
    case 'drop_column':
      return { icon: 'drop', text: `${t('Drop column')} ${c.column}` }
    case 'rename_column':
      return { icon: 'edit', text: `${t('Rename column')} ${c.column} → ${c.newName}` }
    case 'alter_column':
      return { icon: 'edit', text: `${t('Change column')} ${c.column}: ${c.before.dataType}${c.before.nullable ? '' : ' NOT NULL'} → ${c.after.dataType}${c.after.nullable ? '' : ' NOT NULL'}` }
    case 'add_foreign_key':
      return { icon: 'add', text: `${t('Add foreign key')} (${c.fk.columns.join(', ')}) → ${c.fk.refTable}` }
    case 'drop_foreign_key':
      return { icon: 'drop', text: `${t('Drop foreign key')} ${c.name}` }
    case 'add_index':
      return { icon: 'add', text: `${t('Add index')} (${c.index.columns.join(', ')})${c.index.unique ? ' UNIQUE' : ''}` }
    case 'drop_index':
      return { icon: 'drop', text: `${t('Drop index')} ${c.name}` }
    case 'set_primary_key':
      return { icon: 'edit', text: `${t('Primary key')} (${c.before.join(', ')}) → (${c.columns.join(', ')})` }
    case 'rename_table':
      return { icon: 'edit', text: `${t('Rename table')} → ${c.newName}` }
    case 'set_table_comment':
      return { icon: 'edit', text: t('Change table comment') }
  }
}
