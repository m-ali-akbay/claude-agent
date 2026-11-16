export * as ClaudeAISDK from "./aisdk.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { ClaudeAccounts } from "../claude/accounts.js"
import { ClaudeQueryOptions } from "../claude/query-options.js"
import type { ClaudeSessions } from "../claude/sessions.js"
import { ClaudeAgentLanguageModel } from "../language-model/claude-agent-language-model.js"
import { ClaudeInstance } from "./instance.js"

export const register = Effect.fn("ClaudeAISDK.register")(function* (
  ctx: Context,
  instance: ClaudeInstance.Instance,
  sessions: ClaudeSessions.Interface,
) {
  const context = yield* Effect.context<never>()
  const run = Effect.runPromiseWith(context)
  const accounts = ClaudeAccounts.make({ sessions, storage: ClaudeInstance.storage(ctx.storage, instance) })
  yield* ctx.aisdk.hook(
    "sdk",
    (evt) =>
      Effect.sync(() => {
        // opencode spreads the model's settings into options, next to the configured headers and body
        // The token file is read here, so a new token applies from the next model OpenCode creates.
        const connection = {
          ...ClaudeInstance.env(instance),
          ...ClaudeQueryOptions.connectionEnv({
            settings: evt.options,
            headers: evt.options.headers,
            body: evt.options.body,
          }),
        }
        const fast = evt.options.fast === true
        const configDirs = ClaudeQueryOptions.configDirs(evt.options.configDir)
        const dependencies: ClaudeAgentLanguageModel.Dependencies = {
          run: (request, signal) => run(accounts.run(request, instance.members?.() ?? configDirs), { signal }),
        }
        // Always replace: until the opencode fix ships, the npm fallback has already set the placeholder here
        evt.sdk = {
          languageModel: (modelID: string) =>
            new ClaudeAgentLanguageModel.Model(modelID, dependencies, connection, fast, instance.id),
        }
      }),
    { providerID: instance.id },
  )
})
