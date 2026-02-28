import type {
  Provider,
  ProviderPricing,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from "@antseed/node"

interface OpenClawProviderConfig {
  models: string[]
  pricing: ProviderPricing
  maxConcurrency: number
  runtime: any // PluginRuntime from openclaw/plugin-sdk
  cfg: any // OpenClawConfig
  accountId: string
  log?: any
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
  readonly maxConcurrency: number

  private readonly rt: any
  private readonly cfg: any
  private readonly accountId: string
  private readonly log: any
  private activeCount = 0

  constructor(config: OpenClawProviderConfig) {
    this.models = config.models
    this.pricing = config.pricing
    this.maxConcurrency = config.maxConcurrency
    this.rt = config.runtime
    this.cfg = config.cfg
    this.accountId = config.accountId
    this.log = config.log
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (this.activeCount >= this.maxConcurrency) {
      return this.buildErrorResponse(req.requestId, 429, "Max concurrency reached")
    }

    this.activeCount++
    try {
      // 1. Parse the chat completions request body
      const body = JSON.parse(new TextDecoder().decode(req.body)) as {
        model?: string
        messages?: Array<{ role: string; content: string }>
      }
      const userMessage = this.extractLastUserMessage(body.messages ?? [])

      if (!userMessage) {
        return this.buildErrorResponse(req.requestId, 400, "No user message found in request")
      }

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

      return this.buildSuccessResponse(req.requestId, responseText)
    } catch (err) {
      this.log?.error?.(`[AntSeed] Request ${req.requestId} failed: ${(err as Error).message}`)
      return this.buildErrorResponse(req.requestId, 500, (err as Error).message)
    } finally {
      this.activeCount--
    }
  }

  getCapacity(): { current: number; max: number } {
    return { current: this.activeCount, max: this.maxConcurrency }
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
