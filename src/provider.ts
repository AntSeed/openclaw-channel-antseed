import { appendFile } from "node:fs/promises"
import type {
  Provider,
  ProviderPricing,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from "@antseed/node"
import type { PricingMode } from "./types.js"

interface RequestLogConfig {
  enabled: boolean
  path: string
}

interface OpenClawProviderConfig {
  models: string[]
  pricing: ProviderPricing
  pricingMode: PricingMode
  maxConcurrency: number
  runtime: any // PluginRuntime from openclaw/plugin-sdk
  cfg: any // OpenClawConfig
  accountId: string
  log?: any
  allowedBuyers?: string[]
  requestLog?: RequestLogConfig
}

/**
 * Provider implementation that bridges AntSeed P2P requests
 * into OpenClaw's agent runtime.
 *
 * When a buyer sends a chat completion request through the P2P network,
 * this provider extracts the user message, dispatches it through
 * OpenClaw's agent pipeline, collects the response, and returns it
 * as a standard chat completions JSON response.
 */
export class OpenClawProvider implements Provider {
  readonly name = "openclaw"
  readonly models: string[]
  readonly pricing: ProviderPricing
  readonly pricingMode: PricingMode
  readonly maxConcurrency: number

  private readonly rt: any
  private readonly cfg: any
  private readonly accountId: string
  private readonly log: any
  private readonly allowedBuyers: string[]
  private readonly requestLog: RequestLogConfig | undefined
  private activeCount = 0

  constructor(config: OpenClawProviderConfig) {
    this.models = config.models
    this.pricing = config.pricing
    this.pricingMode = config.pricingMode
    this.maxConcurrency = config.maxConcurrency
    this.rt = config.runtime
    this.cfg = config.cfg
    this.accountId = config.accountId
    this.log = config.log
    this.allowedBuyers = config.allowedBuyers ?? []
    this.requestLog = config.requestLog
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const startTime = Date.now()
    const buyerPeerId = req.headers["x-antseed-buyer-peer-id"] ?? null

    // Check buyer allowlist
    if (this.allowedBuyers.length > 0) {
      if (!buyerPeerId || !this.allowedBuyers.includes(buyerPeerId)) {
        this.log?.warn?.(
          `[AntSeed] Blocked request from peer ${buyerPeerId ?? "unknown"} (not in allowlist)`,
        )
        const res = this.buildErrorResponse(req.requestId, 403, "Buyer not allowed")
        await this.writeLog(req, res, startTime, buyerPeerId, null)
        return res
      }
    }

    if (this.activeCount >= this.maxConcurrency) {
      const res = this.buildErrorResponse(req.requestId, 429, "Max concurrency reached")
      await this.writeLog(req, res, startTime, buyerPeerId, null)
      return res
    }

    this.activeCount++
    let model: string | undefined
    let messagePreview: string | undefined
    try {
      // 1. Parse the chat completions request body
      const body = JSON.parse(new TextDecoder().decode(req.body)) as {
        model?: string
        messages?: Array<{ role: string; content: string }>
      }
      model = body.model
      const userMessage = this.extractLastUserMessage(body.messages ?? [])

      if (!userMessage) {
        const res = this.buildErrorResponse(req.requestId, 400, "No user message found in request")
        await this.writeLog(req, res, startTime, buyerPeerId, null)
        return res
      }

      messagePreview = userMessage.slice(0, 100)
      this.log?.debug?.(`[AntSeed] Inbound request ${req.requestId}: "${userMessage.slice(0, 80)}..."`)

      // 2. Resolve agent route
      const route = this.rt.channel.routing.resolveAgentRoute({
        cfg: this.cfg,
        channel: "antseed",
        accountId: this.accountId,
        peer: { kind: "direct", id: req.requestId },
      })

      // 3. Build inbound context for OpenClaw's agent
      const storePath = this.rt.channel.session.resolveStorePath(this.cfg.session?.store, {
        agentId: route.agentId,
      })

      const envelopeOptions = this.rt.channel.reply.resolveEnvelopeFormatOptions(this.cfg)
      const formattedBody = this.rt.channel.reply.formatInboundEnvelope({
        channel: "AntSeed",
        from: `peer:${req.requestId}`,
        body: userMessage,
        chatType: "direct",
        sender: { name: "antseed-buyer", id: req.requestId },
        envelope: envelopeOptions,
      })

      const ctx = this.rt.channel.reply.finalizeInboundContext({
        Body: formattedBody,
        RawBody: userMessage,
        CommandBody: userMessage,
        From: req.requestId,
        To: req.requestId,
        SessionKey: route.sessionKey,
        AccountId: this.accountId,
        ChatType: "direct",
        Provider: "antseed",
        Surface: "antseed",
        CommandAuthorized: true,
        OriginatingChannel: "antseed",
        OriginatingTo: req.requestId,
      })

      // Record the inbound session
      await this.rt.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctx.SessionKey || route.sessionKey,
        ctx,
        updateLastRoute: {
          sessionKey: route.mainSessionKey,
          channel: "antseed",
          to: req.requestId,
          accountId: this.accountId,
        },
        onRecordError: (err: unknown) => {
          this.log?.error?.(`[AntSeed] Failed to record inbound session: ${String(err)}`)
        },
      })

      // 4. Dispatch through agent pipeline and collect response chunks
      const chunks: string[] = []

      await this.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: this.cfg,
        dispatcherOptions: {
          responsePrefix: "",
          deliver: async (payload: any) => {
            const text = payload.markdown || payload.text
            if (text) {
              chunks.push(text)
            }
          },
        },
      })

      // 5. Build chat completions response
      const responseText = chunks.join("\n")
      this.log?.info?.(`[AntSeed] Request ${req.requestId} completed: ${responseText.length} chars`)

      const res = this.buildSuccessResponse(req.requestId, responseText)
      await this.writeLog(req, res, startTime, buyerPeerId, messagePreview)
      return res
    } catch (err) {
      this.log?.error?.(`[AntSeed] Request ${req.requestId} failed: ${(err as Error).message}`)
      const res = this.buildErrorResponse(req.requestId, 500, (err as Error).message)
      await this.writeLog(req, res, startTime, buyerPeerId, messagePreview ?? null)
      return res
    } finally {
      this.activeCount--
    }
  }

  getCapacity(): { current: number; max: number } {
    return { current: this.activeCount, max: this.maxConcurrency }
  }

  private async writeLog(
    req: SerializedHttpRequest,
    res: SerializedHttpResponse,
    startTime: number,
    buyerPeerId: string | null,
    messagePreview: string | null,
  ): Promise<void> {
    if (!this.requestLog?.enabled) return

    const entry = {
      timestamp: new Date().toISOString(),
      requestId: req.requestId,
      buyerPeerId,
      model: this.tryParseModel(req),
      messagePreview,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime,
      responseLength: res.body.byteLength,
    }

    try {
      await appendFile(this.requestLog.path, JSON.stringify(entry) + "\n")
    } catch (err) {
      this.log?.error?.(`[AntSeed] Failed to write request log: ${(err as Error).message}`)
    }
  }

  private tryParseModel(req: SerializedHttpRequest): string | null {
    try {
      const body = JSON.parse(new TextDecoder().decode(req.body)) as { model?: string }
      return body.model ?? null
    } catch {
      return null
    }
  }

  private extractLastUserMessage(
    messages: Array<{ role: string; content: string }>,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user" && messages[i]!.content) {
        return messages[i]!.content
      }
    }
    return null
  }

  private buildSuccessResponse(
    requestId: string,
    content: string,
  ): SerializedHttpResponse {
    const body = JSON.stringify({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    })

    return {
      requestId,
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(body),
    }
  }

  private buildErrorResponse(
    requestId: string,
    statusCode: number,
    message: string,
  ): SerializedHttpResponse {
    const body = JSON.stringify({
      error: { message, type: "server_error", code: statusCode },
    })

    return {
      requestId,
      statusCode,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(body),
    }
  }
}
