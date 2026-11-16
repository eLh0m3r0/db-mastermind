import type { Dialect } from '@dbmastermind/core/browser'

/**
 * A model view's name in its DROP statement. A plain name stays bare, as the view's CREATE (made from its code)
 * writes it, so the database folds both the same way; any other name is quoted by the dialect.
 */
export function viewName(view: { schema?: string; name: string }, dialect: Pick<Dialect, 'quoteIdent'>): string {
  const ident = (n: string) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(n) ? n : dialect.quoteIdent(n))
  return view.schema ? `${ident(view.schema)}.${ident(view.name)}` : ident(view.name)
}
