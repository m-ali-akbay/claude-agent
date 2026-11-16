export * as ClaudeIntegration from "./integration.js"

import type { Connection } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Stream, SubscriptionRef } from "effect"
import { ClaudeProbe } from "../claude/probe.js"
import type { ClaudeStatus } from "../claude/status.js"
import type { ClaudeInstance } from "./instance.js"

export const METHOD_ID = "claude-login"

// The login method only records that the user chose Claude Code. The login itself belongs to `claude`, and the plugin
// never sees a token (PLAN.md, "Ground rules").
export const register = Effect.fn("ClaudeIntegration.register")(function* (
  ctx: Context,
  instance: ClaudeInstance.Instance,
  status: ClaudeStatus.Interface,
) {
  const ID = instance.id
  yield* ctx.integration.transform((editor) => {
    editor.update(ID, (integration) => {
      integration.name = instance.name
    })
    editor.method.update({
      integrationID: ID,
      method: { id: METHOD_ID, type: "external", label: "Claude Code login (claude auth login)" },
    })
    // Paste a token from `claude setup-token`. opencode keeps it and hands it to the plugin as the provider's apiKey.
    editor.method.update({
      integrationID: ID,
      method: { type: "key", label: "Claude Code OAuth token (claude setup-token)" },
    })
  })

  yield* SubscriptionRef.changes(status.state).pipe(
    Stream.runForEach((state) =>
      Effect.gen(function* () {
        if (state.type === "checking") return
        const connection = yield* ctx.integration.connection.active(ID)
        if (!connection) return
        yield* ctx.integration.connection.status({
          integrationID: ID,
          connection,
          status: problem(state),
        })
      }),
    ),
    Effect.forkScoped,
  )

  // Check again when the user connects. opencode keeps a problem per connection, so a new connection starts with
  // none, and the user may have just run `claude auth login`.
  yield* ctx.event.subscribe().pipe(
    Stream.filter((event) => event.type === "credential.switched" && String(event.data.integrationID) === ID),
    Stream.runForEach(() => status.refresh()),
    Effect.forkScoped({ startImmediately: true }),
  )
})

function problem(state: ClaudeStatus.State): Connection.Status | undefined {
  if (state.type === "missing")
    return {
      status: "needs_auth",
      message: "Claude Code is not installed. Install it, then run `claude auth login`.",
      url: "https://code.claude.com/docs/en/setup",
    }
  if (state.type === "failed") return { status: "needs_auth", message: state.message }
  if (state.type === "ready" && !ClaudeProbe.isLoggedIn(state.probe.account))
    return { status: "needs_auth", message: ClaudeProbe.loginMessage(state.configDir) }
  return undefined
}
