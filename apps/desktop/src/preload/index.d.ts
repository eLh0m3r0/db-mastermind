import type { Bridge } from './index'

declare global {
  interface Window {
    mastermind: Bridge
  }
}
