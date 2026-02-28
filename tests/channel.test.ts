import { describe, it, expect } from "vitest"
import { antseedChannel } from "../src/channel.js"

describe("antseedChannel", () => {
  describe("meta", () => {
    it("should have correct id", () => {
      expect(antseedChannel.id).toBe("antseed")
    })

    it("should have correct meta fields", () => {
      expect(antseedChannel.meta.label).toBe("AntSeed")
      expect(antseedChannel.meta.aliases).toContain("p2p")
    })
  })

  describe("capabilities", () => {
    it("should support direct chat only", () => {
      expect(antseedChannel.capabilities.chatTypes).toEqual(["direct"])
    })

    it("should support media", () => {
      expect(antseedChannel.capabilities.media).toBe(true)
    })

    it("should not support reactions or threads", () => {
      expect(antseedChannel.capabilities.reactions).toBe(false)
      expect(antseedChannel.capabilities.threads).toBe(false)
    })
  })

  describe("config", () => {
    it("should return empty account list when not configured", () => {
      const ids = antseedChannel.config.listAccountIds({})
      expect(ids).toEqual([])
    })

    it("should return empty account list when disabled", () => {
      const ids = antseedChannel.config.listAccountIds({
        channels: { antseed: { enabled: false, models: ["openclaw/jeff"] } },
      })
      expect(ids).toEqual([])
    })

    it("should return empty account list when no models", () => {
      const ids = antseedChannel.config.listAccountIds({
        channels: { antseed: { models: [] } },
      })
      expect(ids).toEqual([])
    })

    it("should return default account when configured", () => {
      const ids = antseedChannel.config.listAccountIds({
        channels: { antseed: { models: ["openclaw/jeff"] } },
      })
      expect(ids).toEqual(["default"])
    })

    it("should resolve account with config", () => {
      const cfg = {
        channels: {
          antseed: {
            models: ["openclaw/jeff"],
            displayName: "My Agent",
          },
        },
      }
      const account = antseedChannel.config.resolveAccount(cfg)
      expect(account.accountId).toBe("default")
      expect(account.configured).toBe(true)
      expect(account.enabled).toBe(true)
      expect(account.name).toBe("My Agent")
    })

    it("should report not configured when no models", () => {
      const account = antseedChannel.config.resolveAccount({})
      expect(account.configured).toBe(false)
    })

    it("should return default account id", () => {
      expect(antseedChannel.config.defaultAccountId()).toBe("default")
    })

    it("should check isConfigured based on models", () => {
      expect(
        antseedChannel.config.isConfigured({
          accountId: "default",
          config: { models: ["openclaw/jeff"] },
          enabled: true,
          configured: true,
          name: null,
        }),
      ).toBe(true)

      expect(
        antseedChannel.config.isConfigured({
          accountId: "default",
          config: { models: [] },
          enabled: true,
          configured: false,
          name: null,
        }),
      ).toBe(false)
    })

    it("should resolve account with allowedBuyers config", () => {
      const cfg = {
        channels: {
          antseed: {
            models: ["openclaw/jeff"],
            allowedBuyers: ["peer-abc", "peer-def"],
          },
        },
      }
      const account = antseedChannel.config.resolveAccount(cfg)
      expect(account.config.allowedBuyers).toEqual(["peer-abc", "peer-def"])
    })

    it("should resolve account with requestLog config", () => {
      const cfg = {
        channels: {
          antseed: {
            models: ["openclaw/jeff"],
            requestLog: { enabled: true, path: "/var/log/antseed.jsonl" },
          },
        },
      }
      const account = antseedChannel.config.resolveAccount(cfg)
      expect(account.config.requestLog).toEqual({
        enabled: true,
        path: "/var/log/antseed.jsonl",
      })
    })

    it("should resolve account with per-minute pricing config", () => {
      const cfg = {
        channels: {
          antseed: {
            models: ["openclaw/jeff"],
            pricing: { mode: "per-minute", usdPerMinute: 0.50 },
          },
        },
      }
      const account = antseedChannel.config.resolveAccount(cfg)
      expect(account.config.pricing?.mode).toBe("per-minute")
      expect(account.config.pricing?.usdPerMinute).toBe(0.50)
    })

    it("should resolve account with per-task pricing config", () => {
      const cfg = {
        channels: {
          antseed: {
            models: ["openclaw/jeff"],
            pricing: { mode: "per-task", usdPerTask: 2.00 },
          },
        },
      }
      const account = antseedChannel.config.resolveAccount(cfg)
      expect(account.config.pricing?.mode).toBe("per-task")
      expect(account.config.pricing?.usdPerTask).toBe(2.00)
    })
  })

  describe("outbound", () => {
    it("should have direct delivery mode", () => {
      expect(antseedChannel.outbound.deliveryMode).toBe("direct")
    })

    it("should return stub from sendText", async () => {
      const result = await antseedChannel.outbound.sendText()
      expect(result.channel).toBe("antseed")
    })
  })

  describe("status", () => {
    it("should have correct default runtime", () => {
      expect(antseedChannel.status.defaultRuntime).toEqual({
        accountId: "default",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      })
    })

    it("should report config issue when not configured", () => {
      const issues = antseedChannel.status.collectStatusIssues([
        { configured: false, accountId: "default" },
      ])
      expect(issues).toHaveLength(1)
      expect(issues[0].kind).toBe("config")
    })

    it("should report no issues when configured", () => {
      const issues = antseedChannel.status.collectStatusIssues([
        { configured: true, accountId: "default" },
      ])
      expect(issues).toHaveLength(0)
    })
  })

  describe("gateway", () => {
    it("should reject when no models configured", async () => {
      const ctx = {
        account: {
          accountId: "default",
          config: { models: [] },
          enabled: true,
          configured: false,
          name: null,
        },
        cfg: {},
        log: {},
        getStatus: () => ({}),
        setStatus: () => {},
      }

      await expect(antseedChannel.gateway.startAccount(ctx)).rejects.toThrow(
        "at least one model",
      )
    })
  })
})
