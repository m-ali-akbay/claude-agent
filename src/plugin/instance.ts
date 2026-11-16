export * as ClaudeInstance from "./instance.js"

import { Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ClaudeAccounts } from "../claude/accounts.js"
import type { ClaudeIO } from "../claude/io.js"

// Provider IDs this plugin registers when it is given no accounts, matching the bundled plugin.
export const DEFAULT_ID = "claude-agent"

// The key Claude Agent messages and tool results carry their own flags under. It never changes per instance, so a
// chat moved between accounts still reads its earlier messages.
export const METADATA_KEY = "claude-agent"

/**
 * One Claude account, shown in OpenCode as its own provider.
 *
 * The token is a long-lived Claude Code OAuth token (`claude setup-token`, `sk-ant-oat01-…`). It is read on every
 * request, so a token file can be replaced without restarting OpenCode.
 */
export interface Instance {
  readonly id: Provider.ID
  readonly name: string
  /** The token, or undefined when the account uses the `claude auth login` of its configDir (or ~/.claude). */
  readonly token: () => string | undefined
  readonly configDir?: string
  /** Prefix for this instance's plugin storage keys. Empty for the default instance, so it keeps upstream's data. */
  readonly storagePrefix: string
  /** Where the account comes from: the bundled default, the plugin's options, or a token saved in the UI */
  readonly source: "default" | "options" | "connected" | "pool"
  /**
   * The accounts a pool rotates through. Each request starts on its chat's account and moves to the next when one
   * hits a usage limit. `token` then returns the first member's, for the login check and the model list.
   */
  readonly members?: () => readonly ClaudeAccounts.Member[]
}

export interface AccountOptions {
  readonly name?: string
  /** The OAuth token itself. Prefer `tokenFile` or `tokenEnv` so it stays out of opencode.json. */
  readonly token?: string
  /** A file holding only the token, such as ~/.config/opencode/claude-accounts/work */
  readonly tokenFile?: string
  /** An environment variable holding the token */
  readonly tokenEnv?: string
  /** A Claude Code config folder for this account (CLAUDE_CONFIG_DIR) */
  readonly configDir?: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/i

export function expandHome(value: string) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
}

/**
 * Reads the accounts from the plugin's options:
 *
 * ```json
 * { "package": "…", "options": { "accounts": { "claude-work": { "name": "Claude · Work", "tokenFile": "…" } } } }
 * ```
 *
 * Without `accounts`, the plugin registers a single `claude-agent` provider that behaves like upstream.
 */
export const fromOptions = Effect.fn("ClaudeInstance.fromOptions")(function* (
  options: Context["options"],
  io: ClaudeIO.Interface,
) {
  const accounts = options?.accounts
  if (accounts === undefined || accounts === null) {
    return [
      {
        id: Provider.ID.make(DEFAULT_ID),
        name: "Claude Agent",
        token: () => undefined,
        storagePrefix: "",
        source: "default" as const,
      },
    ]
  }
  if (typeof accounts !== "object" || Array.isArray(accounts)) {
    yield* Effect.logWarning("Claude Agent: `accounts` must be an object keyed by provider ID; ignoring it")
    return []
  }
  const result: Instance[] = []
  for (const [id, raw] of Object.entries(accounts as Record<string, unknown>)) {
    if (!ID_PATTERN.test(id)) {
      yield* Effect.logWarning("Claude Agent: skipping account with an invalid provider ID", { id })
      continue
    }
    const account = (typeof raw === "object" && raw !== null ? raw : {}) as AccountOptions
    result.push({
      id: Provider.ID.make(id),
      name: typeof account.name === "string" && account.name ? account.name : `Claude · ${id}`,
      token: tokenReader(account, io),
      configDir: typeof account.configDir === "string" ? path.resolve(expandHome(account.configDir)) : undefined,
      storagePrefix: `${id}/`,
      source: "options",
    })
  }
  return result
})

function tokenReader(account: AccountOptions, io: ClaudeIO.Interface): () => string | undefined {
  if (typeof account.token === "string" && account.token.trim()) {
    const token = account.token.trim()
    return () => token
  }
  if (typeof account.tokenFile === "string" && account.tokenFile) {
    const file = path.resolve(expandHome(account.tokenFile))
    return () => {
      try {
        return fs.readFileSync(file, "utf8").trim() || undefined
      } catch {
        return undefined
      }
    }
  }
  if (typeof account.tokenEnv === "string" && account.tokenEnv) {
    const name = account.tokenEnv
    return () => io.env()[name]?.trim() || undefined
  }
  return () => undefined
}

/** The environment an instance adds to every `claude` process it starts. */
export function env(instance: Instance): Record<string, string> {
  const result: Record<string, string> = {}
  // A pool's token is chosen per request
  if (instance.members) return result
  const token = instance.token()
  if (token) result.CLAUDE_CODE_OAUTH_TOKEN = token
  if (instance.configDir) result.CLAUDE_CONFIG_DIR = instance.configDir
  return result
}

/** Plugin storage scoped to one instance, so accounts keep separate model lists and Claude sessions. */
export function storage<S extends { get: (key: string) => any; set: (key: string, value: any) => any }>(
  base: S,
  instance: Instance,
): S {
  if (!instance.storagePrefix) return base
  const prefix = instance.storagePrefix
  return {
    ...base,
    get: (key: string) => base.get(prefix + key),
    set: (key: string, value: unknown) => base.set(prefix + key, value),
  }
}
