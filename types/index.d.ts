export type Pending = {
  name: string
  description?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    shhstore: { pending: Shaped<Pending | null> }
  }
}
