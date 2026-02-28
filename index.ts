import { antseedChannel } from "./src/channel.js"

let runtime: any = null

export function getRuntime(): any {
  if (!runtime) {
    throw new Error("AntSeed runtime not initialized — channel not registered yet")
  }
  return runtime
}

export default function register(api: any): void {
  runtime = api
  api.registerChannel({ plugin: antseedChannel })
  api.logger.info("[AntSeed] P2P channel plugin loaded")
}
