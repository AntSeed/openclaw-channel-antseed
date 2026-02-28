import { join } from "node:path"
import { AntseedNode } from "@antseed/node"
import { parseBootstrapList, toBootstrapConfig } from "@antseed/node/discovery"
import { OpenClawProvider } from "./provider.js"
import type {
  AntseedChannelConfig,
  ResolvedAccount,
  GatewayStartContext,
  GatewayStopResult,
} from "./types.js"

function getAntseedConfig(cfg: any): AntseedChannelConfig | undefined {
  return cfg?.channels?.antseed
}

export const antseedChannel = {
  id: "antseed",

  meta: {
    id: "antseed",
    label: "AntSeed",
    selectionLabel: "AntSeed P2P Network",
    docsPath: "/channels/antseed",
    blurb: "Provide AI agent services on the AntSeed peer-to-peer network",
    aliases: ["p2p"],
  },

  capabilities: {
    chatTypes: ["direct"] as Array<"direct">,
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },

  reload: { configPrefixes: ["channels.antseed"] },

  config: {
    listAccountIds: (cfg: any): string[] => {
      const config = getAntseedConfig(cfg)
      if (!config || config.enabled === false) return []
      return config.models?.length ? ["default"] : []
    },

    resolveAccount: (cfg: any, accountId?: string | null): ResolvedAccount => {
      const config = getAntseedConfig(cfg) ?? { models: [] }
      const id = accountId || "default"
      return {
        accountId: id,
        config,
        enabled: config.enabled !== false,
        configured: Boolean(config.models?.length),
        name: config.displayName || null,
      }
    },

    defaultAccountId: (): string => "default",

    isConfigured: (account: ResolvedAccount): boolean =>
      Boolean(account.config?.models?.length),

    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: account.config?.displayName || "AntSeed",
      enabled: account.enabled,
      configured: Boolean(account.config?.models?.length),
    }),
  },

  outbound: {
    deliveryMode: "direct" as const,

    sendText: async () => {
      // Responses go back through Provider.handleRequest return value,
      // not through the outbound sendText path.
      return { channel: "antseed", messageId: "n/a" }
    },
  },

  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx
      const config = account.config

      if (!config.models?.length) {
        throw new Error("AntSeed channel requires at least one model (e.g., openclaw/jeff)")
      }

      const pricingMode = config.pricing?.mode ?? "per-token"

      ctx.log?.info?.(`[AntSeed] Initializing P2P provider...`)
      ctx.log?.info?.(`[AntSeed] Models: ${config.models.join(", ")}`)
      ctx.log?.info?.(`[AntSeed] Pricing mode: ${pricingMode}`)

      // Dynamically import the runtime — set by index.ts at registration time
      const { getRuntime } = await import("../index.js")
      const rt = getRuntime()

      // Resolve request log path
      const requestLogConfig = config.requestLog?.enabled
        ? {
            enabled: true as const,
            path: config.requestLog.path ?? join(config.dataDir ?? ".", "requests.jsonl"),
          }
        : undefined

      // Build token pricing (only used for per-token mode)
      const tokenPricing = {
        defaults: {
          inputUsdPerMillion:
            pricingMode === "per-token" ? (config.pricing?.inputUsdPerMillion ?? 0) : 0,
          outputUsdPerMillion:
            pricingMode === "per-token" ? (config.pricing?.outputUsdPerMillion ?? 0) : 0,
        },
      }

      // Build the Provider that bridges P2P requests → OpenClaw agent
      const provider = new OpenClawProvider({
        models: config.models,
        pricing: tokenPricing,
        pricingMode,
        maxConcurrency: config.maxConcurrency ?? 4,
        runtime: rt,
        cfg,
        accountId: account.accountId,
        log: ctx.log,
        allowedBuyers: config.allowedBuyers,
        requestLog: requestLogConfig,
      })

      // Build bootstrap node list
      const bootstrapEntries = config.bootstrapNodes ?? []
      const bootstrapNodes =
        bootstrapEntries.length > 0
          ? toBootstrapConfig(parseBootstrapList(bootstrapEntries))
          : undefined

      // Create AntseedNode in seller mode
      const node = new AntseedNode({
        role: "seller",
        displayName: config.displayName || "OpenClaw Agent",
        bootstrapNodes,
        dataDir: config.dataDir,
        ...(config.dhtPort ? { dhtPort: config.dhtPort } : {}),
        ...(config.signalingPort ? { signalingPort: config.signalingPort } : {}),
      })

      node.registerProvider(provider)

      let stopped = false

      // Handle abort signal for graceful shutdown
      if (abortSignal) {
        if (abortSignal.aborted) {
          ctx.log?.warn?.("[AntSeed] Abort signal already active, skipping connection")
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: Date.now(),
            lastError: "Connection aborted before start",
          })
          throw new Error("Connection aborted before start")
        }

        abortSignal.addEventListener("abort", () => {
          if (stopped) return
          stopped = true
          ctx.log?.info?.("[AntSeed] Abort signal received, stopping P2P node...")
          node.stop().catch((err: any) => {
            ctx.log?.error?.(`[AntSeed] Error during abort stop: ${err.message}`)
          })
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: Date.now(),
          })
        })
      }

      // Start the P2P node
      try {
        await node.start()
        ctx.setStatus({
          ...ctx.getStatus(),
          running: true,
          lastStartAt: Date.now(),
          lastError: null,
        })
        ctx.log?.info?.(`[AntSeed] P2P provider started`)
        ctx.log?.info?.(`[AntSeed] Peer ID: ${node.peerId}`)
        ctx.log?.info?.(`[AntSeed] DHT port: ${node.dhtPort}, Signaling port: ${node.signalingPort}`)
      } catch (err: any) {
        ctx.log?.error?.(`[AntSeed] Failed to start P2P node: ${err.message}`)
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastError: err.message || "Failed to start",
        })
        throw err
      }

      return {
        stop: () => {
          if (stopped) return
          stopped = true
          ctx.log?.info?.("[AntSeed] Stopping P2P node...")
          node.stop().catch((err: any) => {
            ctx.log?.error?.(`[AntSeed] Error during stop: ${err.message}`)
          })
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            lastStopAt: Date.now(),
          })
          ctx.log?.info?.("[AntSeed] P2P node stopped")
        },
      }
    },
  },

  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    collectStatusIssues: (accounts: any[]) =>
      accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: "antseed",
              accountId: account.accountId,
              kind: "config" as const,
              message: "No models configured (add channels.antseed.models to config)",
            },
          ]
        }
        return []
      }),

    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),

    buildAccountSnapshot: ({ account, runtime, snapshot }: any) => ({
      accountId: account.accountId,
      name: account.config?.displayName ?? "AntSeed",
      enabled: account.enabled,
      configured: account.configured,
      models: account.config?.models ?? [],
      running: runtime?.running ?? snapshot?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? snapshot?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? snapshot?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? snapshot?.lastError ?? null,
    }),
  },
}
