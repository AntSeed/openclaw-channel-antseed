export interface AntseedChannelConfig {
  enabled?: boolean
  models: string[]
  displayName?: string
  pricing?: {
    inputUsdPerMillion?: number
    outputUsdPerMillion?: number
  }
  maxConcurrency?: number
  bootstrapNodes?: string[]
  dhtPort?: number
  signalingPort?: number
  dataDir?: string
}

export interface ResolvedAccount {
  accountId: string
  config: AntseedChannelConfig
  enabled: boolean
  configured: boolean
  name: string | null
}

export interface GatewayStartContext {
  account: ResolvedAccount
  cfg: any
  abortSignal?: AbortSignal
  log?: {
    info?: (...args: any[]) => void
    warn?: (...args: any[]) => void
    error?: (...args: any[]) => void
    debug?: (...args: any[]) => void
  }
  getStatus: () => any
  setStatus: (status: any) => void
}

export interface GatewayStopResult {
  stop: () => void
}
