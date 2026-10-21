import { bridge } from './api'

type Listener = (command: string) => void
const listeners = new Set<Listener>()

/** Menu accelerators, the command palette and shortcuts all funnel through here. */
export function runCommand(command: string): void {
  for (const l of [...listeners]) l(command)
}

export function onCommand(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

bridge.on('menu:command', (command) => runCommand(command))
