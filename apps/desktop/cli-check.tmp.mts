import { runCli } from './src/main/ai/cli'
const provider = process.argv[2] as 'claude-code' | 'codex'
await runCli({
  provider,
  prompt: 'How many rows does the customers table have? Use the dbmastermind tools and answer with just the number.',
  system: 'You are a database assistant. Use the dbmastermind MCP tools.',
  mcp: { command: '/Users/vaclav/Documents/augment-projects/db-mastermind/apps/desktop/release/mac-arm64/DB Mastermind.app/Contents/MacOS/DB Mastermind', args: ['--mcp', '--connection', 'pg1'] },
  signal: new AbortController().signal,
  onEvent: (e) => console.log(JSON.stringify(e).slice(0, 200)),
})
console.log('DONE')
