import { describe, it, expect, vi, beforeEach } from "vitest"
import { OpenClawProvider } from "../src/provider.js"

function makeRequest(
  requestId: string,
  messages: Array<{ role: string; content: string }>,
  model = "openclaw/jeff",
) {
  const body = JSON.stringify({ model, messages })
  return {
    requestId,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
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
  } = {},
) {
  const rt = createMockRuntime(overrides.deliverTexts)
  const provider = new OpenClawProvider({
    models: overrides.models ?? ["openclaw/jeff"],
    pricing: {
      defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 15 },
    },
    maxConcurrency: overrides.maxConcurrency ?? 4,
    runtime: rt,
    cfg: {},
    accountId: "default",
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
