import type { Dashboard, KnowledgeFileInfo, SavedQuery } from '@shared/api'

/**
 * What a knowledge base holds, by kind, filtered by the search: notes (a dashboard file is not one), the dashboards and
 * saved queries shared with the team, and the AI tools (tools/*.sql). `match` decides what the search keeps.
 */
export function knowledgeSections(
  all: { files: KnowledgeFileInfo[]; dashboards: Dashboard[]; queries: SavedQuery[]; tools: string[] },
  match: (text: string) => boolean,
) {
  return {
    notes: all.files.filter((f) => !f.path.startsWith('dashboards/') && match(`${f.path} ${f.title}`)),
    dashboards: all.dashboards.filter((d) => d.shared && match(d.name)),
    queries: all.queries.filter((q) => q.shared && match(`${q.folder ?? ''} ${q.name}`)),
    tools: all.tools.filter((p) => match(p)),
  }
}
