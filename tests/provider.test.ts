import { describe, it, expect, vi, beforeEach } from "vitest"
import { OpenClawProvider } from "../src/provider.js"
import { appendFile } from "node:fs/promises"

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn().mockResolvedValue(undefined),
}))

const appendFileMock = vi.mocked(appendFile)

function makeRequest(
  requestId: string,
  messages: Array<{ role: string; content: string }>,
  model = "openclaw/jeff",
  extraHeaders: Record<string, string> = {},
) {
  const body = JSON.stringify({ model, messages })
  return {
    requestId,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: new TextEncoder().encode(body),
  }
}

function createMockRuntime(deliverTexts: string[] = ["Hello from OpenClaw"]) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          sessionKey: "antseed:test",
          mainSessionKey: "antseed:test",
        }),
      },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/store"),
        readSessionUpdatedAt: vi.fn().mockReturnValue(null),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
        formatInboundEnvelope: vi.fn().mockImplementation(({ body }) => body),
        finalizeInboundContext: vi.fn().mockImplementation((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher: vi
          .fn()
          .mockImplementation(async ({ dispatcherOptions }) => {
            for (const text of deliverTexts) {
              await dispatcherOptions.deliver({ text })
            }
            return { queuedFinal: null }
          }),
      },
    },
  }
}

function createProvider(
  overrides: {
    models?: string[]
    maxConcurrency?: number
    deliverTexts?: string[]
    allowedBuyers?: string[]
    requestLog?: { enabled: boolean; path: string }
    pricingMode?: "per-token" | "per-minute" | "per-task"
  } = {},
) {
  const rt = createMockRuntime(overrides.deliverTexts)
  const provider = new OpenClawProvider({
    models: overrides.models ?? ["openclaw/jeff"],
    pricing: {
      defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 15 },
    },
    pricingMode: overrides.pricingMode ?? "per-token",
    maxConcurrency: overrides.maxConcurrency ?? 4,
    runtime: rt,
    cfg: {},
    accountId: "default",
    allowedBuyers: overrides.allowedBuyers,
    requestLog: overrides.requestLog,
  })
  return { provider, rt }
}

describe("OpenClawProvider", () => {
  describe("handleRequest", () => {
    it("should process a simple message and return chat completion response", async () => {
      const { provider } = createProvider({ deliverTexts: ["Hello! How can I help?"] })
      const req = makeRequest("req-1", [{ role: "user", content: "hi claw" }])

      const res = await provider.handleRequest(req)

      expect(res.statusCode).toBe(200)
      expect(res.requestId).toBe("req-1")

      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.choices[0].message.role).toBe("assistant")
      expect(body.choices[0].message.content).toBe("Hello! How can I help?")
      expect(body.choices[0].finish_reason).toBe("stop")
    })

    it("should concatenate multiple response chunks with newlines", async () => {
      const { provider } = createProvider({
        deliverTexts: ["First part", "Second part", "Third part"],
      })
      const req = makeRequest("req-2", [{ role: "user", content: "do something complex" }])

      const res = await provider.handleRequest(req)

      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.choices[0].message.content).toBe("First part\nSecond part\nThird part")
    })

    it("should extract the last user message from conversation", async () => {
      const { provider, rt } = createProvider()
      const req = makeRequest("req-3", [
        { role: "user", content: "first message" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "second message" },
      ])

      await provider.handleRequest(req)

      const formatCall = rt.channel.reply.formatInboundEnvelope.mock.calls[0][0]
      expect(formatCall.body).toBe("second message")
    })

    it("should return 400 when no user message found", async () => {
      const { provider } = createProvider()
      const req = makeRequest("req-4", [{ role: "assistant", content: "only assistant" }])

      const res = await provider.handleRequest(req)

      expect(res.statusCode).toBe(400)
      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.error.message).toBe("No user message found in request")
    })

    it("should return 400 for empty messages array", async () => {
      const { provider } = createProvider()
      const req = makeRequest("req-5", [])

      const res = await provider.handleRequest(req)

      expect(res.statusCode).toBe(400)
    })

    it("should return 500 when agent pipeline throws", async () => {
      const rt = createMockRuntime()
      rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(
        new Error("Agent crashed"),
      )
      const provider = new OpenClawProvider({
        models: ["openclaw/jeff"],
        pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
        pricingMode: "per-token",
        maxConcurrency: 4,
        runtime: rt,
        cfg: {},
        accountId: "default",
      })

      const req = makeRequest("req-6", [{ role: "user", content: "crash" }])
      const res = await provider.handleRequest(req)

      expect(res.statusCode).toBe(500)
      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.error.message).toBe("Agent crashed")
    })

    it("should return 500 for malformed request body", async () => {
      const { provider } = createProvider()
      const req = {
        requestId: "req-7",
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode("not json"),
      }

      const res = await provider.handleRequest(req)

      expect(res.statusCode).toBe(500)
    })
  })

  describe("buyer allowlist", () => {
    it("should allow any peer when allowlist is empty", async () => {
      const { provider } = createProvider({ allowedBuyers: [] })
      const req = makeRequest("req-allow-1", [{ role: "user", content: "hello" }], "openclaw/jeff", {
        "x-antseed-buyer-peer-id": "some-peer-id",
      })

      const res = await provider.handleRequest(req)
      expect(res.statusCode).toBe(200)
    })

    it("should allow peer in allowlist", async () => {
      const { provider } = createProvider({ allowedBuyers: ["peer-abc", "peer-def"] })
      const req = makeRequest("req-allow-2", [{ role: "user", content: "hello" }], "openclaw/jeff", {
        "x-antseed-buyer-peer-id": "peer-abc",
      })

      const res = await provider.handleRequest(req)
      expect(res.statusCode).toBe(200)
    })

    it("should block peer not in allowlist", async () => {
      const { provider } = createProvider({ allowedBuyers: ["peer-abc"] })
      const req = makeRequest("req-block-1", [{ role: "user", content: "hello" }], "openclaw/jeff", {
        "x-antseed-buyer-peer-id": "peer-xyz",
      })

      const res = await provider.handleRequest(req)
      expect(res.statusCode).toBe(403)

      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.error.message).toBe("Buyer not allowed")
    })

    it("should block when no peer ID header and allowlist is set", async () => {
      const { provider } = createProvider({ allowedBuyers: ["peer-abc"] })
      const req = makeRequest("req-block-2", [{ role: "user", content: "hello" }])

      const res = await provider.handleRequest(req)
      expect(res.statusCode).toBe(403)
    })
  })

  describe("request logging", () => {
    beforeEach(() => {
      appendFileMock.mockClear()
    })

    it("should write log entry on successful request", async () => {
      const { provider } = createProvider({
        requestLog: { enabled: true, path: "/tmp/test.jsonl" },
        deliverTexts: ["response"],
      })
      const req = makeRequest("req-log-1", [{ role: "user", content: "hello world" }], "openclaw/jeff", {
        "x-antseed-buyer-peer-id": "buyer-123",
      })

      await provider.handleRequest(req)

      expect(appendFileMock).toHaveBeenCalledTimes(1)
      const [path, data] = appendFileMock.mock.calls[0]!
      expect(path).toBe("/tmp/test.jsonl")

      const entry = JSON.parse((data as string).trim())
      expect(entry.requestId).toBe("req-log-1")
      expect(entry.buyerPeerId).toBe("buyer-123")
      expect(entry.model).toBe("openclaw/jeff")
      expect(entry.messagePreview).toBe("hello world")
      expect(entry.statusCode).toBe(200)
      expect(entry.durationMs).toBeTypeOf("number")
      expect(entry.responseLength).toBeTypeOf("number")
    })

    it("should not write log when logging is disabled", async () => {
      const { provider } = createProvider()
      const req = makeRequest("req-log-2", [{ role: "user", content: "hello" }])

      await provider.handleRequest(req)

      expect(appendFileMock).not.toHaveBeenCalled()
    })

    it("should log blocked requests", async () => {
      const { provider } = createProvider({
        allowedBuyers: ["peer-abc"],
        requestLog: { enabled: true, path: "/tmp/test.jsonl" },
      })
      const req = makeRequest("req-log-3", [{ role: "user", content: "hello" }], "openclaw/jeff", {
        "x-antseed-buyer-peer-id": "bad-peer",
      })

      await provider.handleRequest(req)

      expect(appendFileMock).toHaveBeenCalledTimes(1)
      const entry = JSON.parse((appendFileMock.mock.calls[0]![1] as string).trim())
      expect(entry.statusCode).toBe(403)
    })

    it("should truncate message preview to 100 chars", async () => {
      const longMessage = "a".repeat(200)
      const { provider } = createProvider({
        requestLog: { enabled: true, path: "/tmp/test.jsonl" },
        deliverTexts: ["ok"],
      })
      const req = makeRequest("req-log-4", [{ role: "user", content: longMessage }])

      await provider.handleRequest(req)

      const entry = JSON.parse((appendFileMock.mock.calls[0]![1] as string).trim())
      expect(entry.messagePreview).toHaveLength(100)
    })
  })

  describe("pricing mode", () => {
    it("should store per-token pricing mode", () => {
      const { provider } = createProvider({ pricingMode: "per-token" })
      expect(provider.pricingMode).toBe("per-token")
    })

    it("should store per-minute pricing mode", () => {
      const { provider } = createProvider({ pricingMode: "per-minute" })
      expect(provider.pricingMode).toBe("per-minute")
    })

    it("should store per-task pricing mode", () => {
      const { provider } = createProvider({ pricingMode: "per-task" })
      expect(provider.pricingMode).toBe("per-task")
    })
  })

  describe("concurrency", () => {
    it("should return 429 when max concurrency is reached", async () => {
      const rt = createMockRuntime()
      // Make dispatch hang so the request stays in-flight
      rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        () => new Promise(() => {}),
      )
      const provider = new OpenClawProvider({
        models: ["openclaw/jeff"],
        pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
        pricingMode: "per-token",
        maxConcurrency: 1,
        runtime: rt,
        cfg: {},
        accountId: "default",
      })

      // First request hangs
      const req1 = makeRequest("req-a", [{ role: "user", content: "hello" }])
      provider.handleRequest(req1) // don't await

      // Wait a tick for activeCount to increment
      await new Promise((r) => setTimeout(r, 10))

      // Second request should be rejected
      const req2 = makeRequest("req-b", [{ role: "user", content: "hello again" }])
      const res = await provider.handleRequest(req2)

      expect(res.statusCode).toBe(429)
      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.error.message).toBe("Max concurrency reached")
    })

    it("should report correct capacity", async () => {
      const { provider } = createProvider({ maxConcurrency: 8 })

      const cap = provider.getCapacity()
      expect(cap.current).toBe(0)
      expect(cap.max).toBe(8)
    })

    it("should decrement active count after request completes", async () => {
      const { provider } = createProvider()
      const req = makeRequest("req-c", [{ role: "user", content: "hello" }])

      await provider.handleRequest(req)

      expect(provider.getCapacity().current).toBe(0)
    })

    it("should decrement active count after request fails", async () => {
      const rt = createMockRuntime()
      rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(
        new Error("fail"),
      )
      const provider = new OpenClawProvider({
        models: ["openclaw/jeff"],
        pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
        pricingMode: "per-token",
        maxConcurrency: 4,
        runtime: rt,
        cfg: {},
        accountId: "default",
      })

      const req = makeRequest("req-d", [{ role: "user", content: "fail" }])
      await provider.handleRequest(req)

      expect(provider.getCapacity().current).toBe(0)
    })
  })

  describe("routing", () => {
    it("should call resolveAgentRoute with correct channel and peer", async () => {
      const { provider, rt } = createProvider()
      const req = makeRequest("req-route", [{ role: "user", content: "test" }])

      await provider.handleRequest(req)

      expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith({
        cfg: {},
        channel: "antseed",
        accountId: "default",
        peer: { kind: "direct", id: "req-route" },
      })
    })

    it("should record inbound session", async () => {
      const { provider, rt } = createProvider()
      const req = makeRequest("req-session", [{ role: "user", content: "test" }])

      await provider.handleRequest(req)

      expect(rt.channel.session.recordInboundSession).toHaveBeenCalledTimes(1)
      const call = rt.channel.session.recordInboundSession.mock.calls[0][0]
      expect(call.storePath).toBe("/tmp/store")
      expect(call.updateLastRoute.channel).toBe("antseed")
    })
  })

  describe("response format", () => {
    it("should return valid OpenAI chat completion format", async () => {
      const { provider } = createProvider({ deliverTexts: ["response text"] })
      const req = makeRequest("req-fmt", [{ role: "user", content: "hello" }])

      const res = await provider.handleRequest(req)
      const body = JSON.parse(new TextDecoder().decode(res.body))

      expect(body.id).toBe("chatcmpl-req-fmt")
      expect(body.object).toBe("chat.completion")
      expect(body.created).toBeTypeOf("number")
      expect(body.choices).toHaveLength(1)
      expect(body.choices[0].index).toBe(0)
      expect(body.choices[0].message.role).toBe("assistant")
      expect(body.choices[0].finish_reason).toBe("stop")
    })

    it("should set content-type header to application/json", async () => {
      const { provider } = createProvider()
      const req = makeRequest("req-hdr", [{ role: "user", content: "hello" }])

      const res = await provider.handleRequest(req)

      expect(res.headers["content-type"]).toBe("application/json")
    })

    it("should handle empty agent response", async () => {
      const { provider } = createProvider({ deliverTexts: [] })
      const req = makeRequest("req-empty", [{ role: "user", content: "hello" }])

      const res = await provider.handleRequest(req)

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(new TextDecoder().decode(res.body))
      expect(body.choices[0].message.content).toBe("")
    })
  })
})
