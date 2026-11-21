// Minimal typings for the part of js-yaml the app uses (compose files in project-connections.ts).
declare module 'js-yaml' {
  export function load(text: string, options?: { filename?: string; json?: boolean }): unknown
}
