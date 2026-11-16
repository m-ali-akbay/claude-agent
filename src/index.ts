import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { ClaudeIO } from "./claude/io.js"
import { ClaudeStatus } from "./claude/status.js"
import { ClaudeSessions } from "./claude/sessions.js"
import { ClaudeAISDK } from "./plugin/aisdk.js"
import { ClaudeConnected } from "./plugin/connected.js"
import { ClaudeInstance } from "./plugin/instance.js"
import { ClaudeIntegration } from "./plugin/integration.js"
import { ClaudeInstructions } from "./plugin/instructions.js"
import { ClaudeProvider } from "./plugin/provider.js"
import { ClaudeSessionHooks } from "./plugin/session.js"

export const ID = "opencode.claude-multi"

// Each account keeps its own `claude` processes. A registry lives outside setup's scope, so a reload can adopt them.
export class Registries {
  private readonly map = new Map<string, ClaudeSessions.Registry>()
  constructor(first?: ClaudeSessions.Registry) {
    if (first) this.map.set(ClaudeInstance.DEFAULT_ID, first)
  }
  get(id: string) {
    let registry = this.map.get(id)
    if (!registry) {
      registry = ClaudeSessions.registry()
      this.map.set(id, registry)
    }
    return registry
  }
}

export const make = (io: ClaudeIO.Interface, registry?: ClaudeSessions.Registry | Registries) => {
  const registries = registry instanceof Registries ? registry : new Registries(registry)
  return define({
    id: ID,
    effect: Effect.fn("ClaudeMulti.Plugin")(function* (ctx) {
      // Claude Agent runs the local `claude` binary, so skip remote workspaces, where it can't run.
      if (ctx.location.workspaceID !== undefined) return

      const instances = yield* ClaudeInstance.fromOptions(ctx.options, io)
      for (const instance of instances) {
        if (instance.storagePrefix && !instance.token() && !instance.configDir) {
          yield* Effect.logWarning("Claude Agent account has no token; it falls back to `claude auth login`", {
            providerID: instance.id,
          })
        }
        yield* setup(ctx, instance, io, registries.get(instance.id))
      }
      // Accounts added from the UI: each OAuth token saved for "Claude Account" becomes a provider.
      if (ctx.options?.connected !== false) {
        yield* ClaudeConnected.register({
          ctx,
          reserved: new Set(instances.map((instance) => String(instance.id))),
          start: (instance) => setup(ctx, instance, io, registries.get(instance.id)),
        })
      }
    }),
  })
}

const setup = Effect.fn("ClaudeMulti.setup")(function* (
  ctx: Parameters<Parameters<typeof define>[0]["effect"]>[0],
  instance: ClaudeInstance.Instance,
  io: ClaudeIO.Interface,
  registry: ClaudeSessions.Registry,
) {
  const storage = ClaudeInstance.storage(ctx.storage, instance)
  const status = yield* ClaudeStatus.make(io, () => ClaudeProvider.connection(ctx, instance))
  const sessions = yield* registry.attach({ io, status, storage, directory: ctx.location.directory })
  yield* ctx.event
    .subscribe({
      types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
    })
    .pipe(
      Stream.runForEach((event) => sessions.idle(event.data.sessionID)),
      Effect.forkScoped({ startImmediately: true }),
    )
  yield* ClaudeProvider.register(ctx, instance, status, io)
  // A UI account's login lives in its "Claude Account" credential, so it gets no integration of its own.
  if (instance.source !== "connected") yield* ClaudeIntegration.register(ctx, instance, status)
  yield* ClaudeAISDK.register(ctx, instance, sessions)
  yield* ClaudeSessionHooks.register(ctx, instance)
  yield* ClaudeInstructions.register(ctx, instance)
})

export default make(ClaudeIO.real, new Registries())
