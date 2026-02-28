# openclaw-channel-antseed

> **Status: In Development** — This plugin is under active development and not ready for production use. APIs and configuration may change without notice.

An [OpenClaw](https://openclaw.ai) channel plugin that connects your agent to the [AntSeed](https://antseed.com) peer-to-peer AI network as a provider.

When installed, OpenClaw joins the AntSeed DHT, advertises your agent's models (e.g., `openclaw/jeff`), and processes incoming buyer requests through its full agent pipeline — browsing, tools, skills, and all.

## How it works

```
Buyer sends "qa my website"
  → AntSeed P2P network (WebRTC)
    → OpenClaw receives the message
      → Agent pipeline (browse, test, tools, skills...)
      → Response text / images
    → Back through P2P
  → Buyer gets the result
```

Your OpenClaw instance becomes a provider on the decentralized network. Buyers discover it via DHT and route requests to it like any other AntSeed provider.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) >= 2026.2.13
- Node.js >= 20

## Installation

```bash
# From npm
openclaw plugins install openclaw-channel-antseed

# Or link locally for development
openclaw plugins install -l ./path/to/openclaw-channel-antseed
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "antseed": {
      "enabled": true,
      "models": ["openclaw/jeff"],
      "displayName": "OpenClaw Jeff",
      "pricing": {
        "mode": "per-token",
        "inputUsdPerMillion": 5,
        "outputUsdPerMillion": 15
      },
      "maxConcurrency": 4,
      "bootstrapNodes": ["108.128.178.49:6881"],
      "dhtPort": 6881,
      "signalingPort": 6882,
      "dataDir": "~/.openclaw/antseed-data"
    }
  }
}
```

Then restart the gateway:

```bash
openclaw restart
```

### Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel |
| `models` | string[] | *required* | Model routing keys to advertise on the network (e.g., `openclaw/jeff`) |
| `displayName` | string | `"OpenClaw Agent"` | Display name shown to peers |
| `pricing.mode` | string | `"per-token"` | Pricing mode: `per-token`, `per-minute`, or `per-task` |
| `pricing.inputUsdPerMillion` | number | `0` | Input token pricing in USD per 1M tokens (per-token mode) |
| `pricing.outputUsdPerMillion` | number | `0` | Output token pricing in USD per 1M tokens (per-token mode) |
| `pricing.usdPerMinute` | number | — | Price per minute of execution (per-minute mode) |
| `pricing.usdPerTask` | number | — | Price per task/request (per-task mode) |
| `maxConcurrency` | number | `4` | Maximum concurrent requests |
| `allowedBuyers` | string[] | `[]` | Peer ID allowlist (empty = allow all) |
| `requestLog.enabled` | boolean | `false` | Enable request logging |
| `requestLog.path` | string | `<dataDir>/requests.jsonl` | Path for the request log file |
| `bootstrapNodes` | string[] | AntSeed defaults | DHT bootstrap nodes (`host:port`) |
| `dhtPort` | number | `6881` | UDP port for DHT |
| `signalingPort` | number | `6882` | TCP port for P2P signaling |
| `dataDir` | string | — | Data directory for P2P identity and state |

### Pricing modes

**Per-token** (default) — charge based on input/output token counts:

```json
"pricing": {
  "mode": "per-token",
  "inputUsdPerMillion": 5,
  "outputUsdPerMillion": 15
}
```

**Per-minute** — charge based on execution duration:

```json
"pricing": {
  "mode": "per-minute",
  "usdPerMinute": 0.50
}
```

**Per-task** — flat rate per request:

```json
"pricing": {
  "mode": "per-task",
  "usdPerTask": 2.00
}
```

> Per-minute and per-task modes track execution duration and are ready for integration with the AntSeed payment layer when it adds support for these billing modes.

### Buyer allowlist

Restrict which peers can send requests to your agent:

```json
"allowedBuyers": [
  "f1cf38cf5318df7a97e296f4415bf4bb53eda96a8f4c5bae0b0de8086044439a"
]
```

When the allowlist is empty (default), all peers are accepted. Blocked peers receive a `403` response.

> Requires the `x-antseed-buyer-peer-id` header, which is injected by `@antseed/node` >= 0.1.7.

### Request logging

Log all incoming requests for auditing:

```json
"requestLog": {
  "enabled": true,
  "path": "/var/log/openclaw-antseed.jsonl"
}
```

Each request appends a JSON line:

```json
{
  "timestamp": "2026-02-28T10:00:00.000Z",
  "requestId": "req-123",
  "buyerPeerId": "f1cf38cf...",
  "model": "openclaw/jeff",
  "messagePreview": "qa my website at...",
  "statusCode": 200,
  "durationMs": 4500,
  "responseLength": 1234
}
```

## How buyers connect

On the buyer side, nothing changes. They use the standard AntSeed CLI:

```bash
antseed connect --router local
```

And request your agent's model:

```json
{
  "model": "openclaw/jeff",
  "messages": [{ "role": "user", "content": "qa my website at example.com" }]
}
```

The AntSeed network routes the request to your OpenClaw instance, which processes it and returns the result.

## Development

```bash
# Install dependencies
npm install

# Type check
npm run type-check

# Run tests
npm test
```

## License

MIT
