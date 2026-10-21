import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // Workspace packages are TypeScript source and the AI SDK is ESM-only: bundle them.
      // Database drivers stay external (native/optional modules, large).
      externalizeDeps: {
        exclude: [
          '@dbmastermind/core',
          'dbmastermind-mcp',
          'ai',
          '@ai-sdk/anthropic',
          '@ai-sdk/azure',
          '@ai-sdk/google',
          '@ai-sdk/openai',
          '@ai-sdk/openai-compatible',
          '@openrouter/ai-sdk-provider',
          '@modelcontextprotocol/sdk',
          'fflate',
        ],
      },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@dbmastermind/core'] },
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
