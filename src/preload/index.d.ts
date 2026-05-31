import type { WotchCodeApi } from './index'

declare global {
  interface Window {
    api: WotchCodeApi
  }
}
