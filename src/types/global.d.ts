import type { ThShellApi } from '../../electron/types'

declare global {
  interface Window {
    api: ThShellApi
  }
}

export {}
