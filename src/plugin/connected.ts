export * as ClaudeConnected from "./connected.js"

import { Integration, Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Exit, Option, Scope, Semaphore, Stream } from "effect"
import { SdkPlaceholder } from "../language-model/sdk-placeholder.js"
import type { ClaudeInstance } from "./instance.js"

/**
 * Accounts added from OpenCode's own UI.
 *
 * The plugin lists a "Claude Account" provider. Each OAuth token saved for it (/connect, or the providers settings) is
 * one credential, and every credential becomes a provider of its own, named after the credential's label:
 * a token labelled "Ali" is `claude-ali`, shown as "Claude · Ali". Adding, relabelling or removing a token updates the
 * providers while OpenCode runs.
 */
export const HUB_ID = "claude-account"
export const HUB_NAME = "Claude Account"
export const POOL_ID = "claude-pool"
export const POOL_NAME = "Claude · Pool (auto-switch)"
export const METHOD_LABEL = "Claude Code OAuth token (claude setup-token)"
export const NAME_FIELD = "name"

// opencode labels a credential saved without a label after its integration: "Claude Account", "Claude Account 2", …
const DEFAULT_LABEL = new RegExp(`^${HUB_NAME}( \\d+)?$`)

/** A label the user chose (connect with a label, or rename) wins; otherwise the name from the token form. */
export function accountName(label: string, answered: unknown) {
  const own = label.trim()
  if (own && !DEFAULT_LABEL.test(own)) return own
  if (typeof answered === "string" && answered.trim()) return answered.trim()
  return own
}

export interface Running {
  readonly credentialID: string
  readonly label: string
  readonly instance: ClaudeInstance.Instance
  readonly scope: Scope.Closeable
  readonly holder: { token: string }
}

type Start = (instance: ClaudeInstance.Instance) => Effect.Effect<void, never, Scope.Scope>

export const register = Effect.fn("ClaudeConnected.register")(function* (input: {
  readonly ctx: Context
  /** Provider IDs already taken by accounts from opencode.json */
  readonly reserved: ReadonlySet<string>
  readonly start: Start
  /** Also register `claude-pool`, which moves a request to the next account when one hits a usage limit */
  readonly pool?: boolean
}) {
  const { ctx } = input
  const integrationID = Integration.ID.make(HUB_ID)

  // A provider is what gives an integration its place in the UI. It has no models of its own, and "auto" lists it as
  // connected only once a token is saved, so before that it shows among the providers to connect.
  yield* ctx.provider.transform((editor) => {
    editor.add({
      info: {
        id: Provider.ID.make(HUB_ID),
        name: HUB_NAME,
        activation: "auto",
        package: `aisdk:${SdkPlaceholder.url}`,
      },
      models: [],
    })
  })
  yield* ctx.integration.transform((editor) => {
    editor.update(HUB_ID, (integration) => {
      integration.name = HUB_NAME
    })
    editor.method.update({
      integrationID: HUB_ID,
      method: {
        type: "key",
        label: METHOD_LABEL,
        // opencode keeps the answer in the credential's metadata and labels the credential "Claude Account N",
        // so the account is named from this field until the credential is renamed.
        form: [
          {
            key: NAME_FIELD,
            type: "string",
            title: "Account name",
            description: "Shown as Claude · <name>; the provider ID is claude-<name>",
            placeholder: "Work",
            required: true,
            minLength: 1,
            maxLength: 40,
          },
        ],
      },
    })
  })

  const parent = yield* Effect.scope
  const running = new Map<string, Running>()
  const lock = yield* Semaphore.make(1)

  const stop = Effect.fn("ClaudeConnected.stop")(function* (entry: Running) {
    running.delete(entry.credentialID)
    yield* Scope.close(entry.scope, Exit.void)
  })

  const reconcile = Effect.fn("ClaudeConnected.reconcile")(function* () {
    const info = yield* ctx.integration.get({ integrationID }).pipe(Effect.option)
    const credentials = Option.match(info, {
      onNone: () => [],
      onSome: (result) => result.data.connections.filter((c) => c.type === "credential"),
    })
    let changed = false

    const seen = new Set<string>()
    for (const connection of credentials) {
      seen.add(connection.id)
      const resolved = yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
      const value = resolved?.type === "key" ? resolved.key.trim() : undefined
      const label = accountName(connection.label, resolved?.metadata?.[NAME_FIELD])
      const current = running.get(connection.id)
      if (!value) {
        if (current) {
          yield* stop(current)
          changed = true
        }
        continue
      }
      if (current && current.label === label) {
        // The token is read for each new model, so a changed token applies without a restart.
        current.holder.token = value
        continue
      }
      if (current) {
        yield* stop(current)
        changed = true
      }
      const taken = new Set([
        ...input.reserved,
        POOL_ID,
        ...[...running.values()].map((entry) => String(entry.instance.id)),
      ])
      const id = providerID(label, connection.id, taken)
      const holder = { token: value }
      const entry: Running = {
        credentialID: connection.id,
        label,
        holder,
        scope: yield* Scope.fork(parent),
        instance: {
          id: Provider.ID.make(id),
          name: `Claude · ${label || id.replace(/^claude-/, "")}`,
          token: () => holder.token,
          // Keyed by the credential, so a renamed account keeps its sessions and model list, and a new account never
          // picks up data left by an earlier account of the same name.
          storagePrefix: `account/${connection.id}/`,
          source: "connected",
        },
      }
      running.set(connection.id, entry)
      yield* input.start(entry.instance).pipe(Scope.provide(entry.scope))
      changed = true
    }
    for (const entry of [...running.values()]) {
      if (seen.has(entry.credentialID)) continue
      yield* stop(entry)
      changed = true
    }
    if (changed) yield* ctx.provider.reload()
  }, lock.withPermit)

  yield* ctx.event.subscribe().pipe(
    Stream.filter(
      (event) =>
        event.type === "credential.updated" ||
        (event.type === "credential.switched" && String(event.data.integrationID) === HUB_ID),
    ),
    Stream.runForEach(() =>
      reconcile().pipe(Effect.catchCause((cause) => Effect.logWarning("Claude Account reload failed", { cause }))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* reconcile().pipe(Effect.catchCause((cause) => Effect.logWarning("Claude Account load failed", { cause })))

  if (input.pool !== false) {
    // Accounts in name order, so the pool starts new chats on the same account every time
    const members = () =>
      [...running.values()]
        .sort((a, b) => a.label.localeCompare(b.label) || a.credentialID.localeCompare(b.credentialID))
        .map((entry) => ({ key: entry.credentialID, env: { CLAUDE_CODE_OAUTH_TOKEN: entry.holder.token } }))
    yield* input.start({
      id: Provider.ID.make(POOL_ID),
      name: POOL_NAME,
      // A pool of one is the account itself, so the pool lists models only from two accounts on.
      token: () => {
        const list = members()
        return list.length >= 2 ? list[0]!.env.CLAUDE_CODE_OAUTH_TOKEN : undefined
      },
      storagePrefix: "pool/",
      source: "pool",
      members,
    })
  }

  return { running } as const
})

const TURKISH: Record<string, string> = {
  ı: "i",
  İ: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ç: "c",
  Ç: "c",
  ö: "o",
  Ö: "o",
  ü: "u",
  Ü: "u",
}

export function slug(label: string) {
  const result = label
    .replace(/[ıİşŞğĞçÇöÖüÜ]/g, (char) => TURKISH[char] ?? char)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // "Claude Work" would otherwise become claude-claude-work
  return result.replace(/^claude-(?=.)/, "")
}

export function providerID(label: string, credentialID: string, taken: ReadonlySet<string>) {
  const base = slug(label)
  const tail = slug(credentialID).slice(-6) || "account"
  const first = base ? `claude-${base}` : `claude-${tail}`
  if (!taken.has(first) && first !== HUB_ID && first !== POOL_ID) return first
  const second = `${first}-${tail}`
  if (!taken.has(second)) return second
  for (let i = 2; ; i++) if (!taken.has(`${second}-${i}`)) return `${second}-${i}`
}
