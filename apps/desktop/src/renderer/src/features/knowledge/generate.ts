import { askAi } from '@/store/ui'

export const GENERATE_KB_PROMPT = `Document this database into the knowledge base.

1. Study the schema with list_tables, describe_table and get_relationships. Sample a few rows of important tables to understand codes and statuses.
2. Write README.md: what the database is for, its main areas, and a map of the most important tables.
3. Write one file per functional area (e.g. sales.md, customers.md): the purpose of each table, important columns, meaning of codes/enum values, how tables join, and common pitfalls.
4. Put \`tables: [...]\` in each file's front matter. When tables are clearly related but have no foreign key, add \`relations: ["table.column -> other_table.column"]\`.

Be factual: say "probably" when you infer meaning from data. Keep each file focused and skimmable.`

export function askAiToDocument() {
  askAi({ prompt: GENERATE_KB_PROMPT })
}
