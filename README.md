# openclaw-channel-antseed

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
| `pricing.inputUsdPerMillion` | number | `0` | Input token pricing in USD per 1M tokens |
| `pricing.outputUsdPerMillion` | number | `0` | Output token pricing in USD per 1M tokens |
| `maxConcurrency` | number | `4` | Maximum concurrent requests |
| `bootstrapNodes` | string[] | AntSeed defaults | DHT bootstrap nodes (`host:port`) |
| `dhtPort` | number | `6881` | UDP port for DHT |
| `signalingPort` | number | `6882` | TCP port for P2P signaling |
| `dataDir` | string | — | Data directory for P2P identity and state |

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
