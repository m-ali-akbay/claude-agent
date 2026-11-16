export * as ClaudeProvider from "./provider.js"

import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import { Model, Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema, Stream, SubscriptionRef } from "effect"
import type { ClaudeIO } from "../claude/io.js"
import type { ClaudeProbe } from "../claude/probe.js"
import { ClaudeQueryOptions } from "../claude/query-options.js"
import type { ClaudeStatus } from "../claude/status.js"
import { SdkPlaceholder } from "../language-model/sdk-placeholder.js"
import { ClaudeInstance } from "./instance.js"

export const ID = Provider.ID.make(ClaudeInstance.DEFAULT_ID)

// The model list we keep between starts, so opencode can list models without running `claude`
const CatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  efforts: Schema.Array(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Number),
  resolvedModel: Schema.optionalKey(Schema.String),
})
export type CatalogModel = typeof CatalogModel.Type
const Catalog = Schema.Struct({
  priceSource: Schema.optionalKey(Provider.ID),
  models: Schema.Array(CatalogModel),
  // Whether a full check wrote the list. A list only chat reports wrote may be missing models, so it is checked again.
  checked: Schema.optionalKey(Schema.Boolean),
})
type Catalog = typeof Catalog.Type
const CATALOG_KEY = "models"

// Claude Code's own aliases, which every subscription accepts. An account with a token lists them until its first
// check reports the full list, so a newly added account has models to pick at once.
const STARTER: readonly CatalogModel[] = [
  { id: "opus", name: "Opus", efforts: [] },
  { id: "sonnet", name: "Sonnet", efforts: [] },
  { id: "haiku", name: "Haiku", efforts: [] },
]

// Mantle is Bedrock serving Anthropic's API, and opencode drops most of its `anthropic.…` IDs from Bedrock's list,
// so it uses Anthropic's prices.
const PRICE_SOURCES: Partial<Record<NonNullable<AccountInfo["apiProvider"]>, Provider.ID>> = {
  firstParty: Provider.ID.anthropic,
  anthropicAws: Provider.ID.anthropic,
  anthropicGoogleCloud: Provider.ID.anthropic,
  mantle: Provider.ID.anthropic,
  bedrock: Provider.ID.amazonBedrock,
  vertex: Provider.ID.googleVertex,
  foundry: Provider.ID.azure,
}

export const register = Effect.fn("ClaudeProvider.register")(function* (
  ctx: Context,
  instance: ClaudeInstance.Instance,
  status: ClaudeStatus.Interface,
  io: ClaudeIO.Interface,
) {
  const ID = instance.id
  const storage = ClaudeInstance.storage(ctx.storage, instance)
  const saved = Schema.decodeUnknownOption(Catalog)(yield* storage.get(CATALOG_KEY))
  const current = { catalog: Option.getOrElse(saved, (): Catalog => ({ models: [] })) }
  // A chat's startup report lists models without measuring their context windows, so a model that is new to the
  // list falls back to the default limit until the full check measures it. A check that changes nothing ends the loop.
  const unmeasured = (models: readonly CatalogModel[]) => models.some((model) => model.contextWindow === undefined)
  const listed = () =>
    current.catalog.models.length === 0 && instance.token() !== undefined ? STARTER : current.catalog.models

  yield* ctx.provider.transform((editor) => {
    const source = current.catalog.priceSource
    const prices = source ? editor.get(source)?.models : undefined
    editor.add({
      info: {
        id: ID,
        name: instance.name,
        // An account with its own token needs no /connect, so it is listed as soon as the plugin loads.
        // A pool with fewer than two accounts stays out of the provider list altogether.
        activation: instance.token() ? "enabled" : instance.source === "pool" ? "disabled" : "auto",
        package: `aisdk:${SdkPlaceholder.url}`,
      },
      models: listed().map((model) => toModel(ID, model, prices)),
    })
  })

  yield* SubscriptionRef.changes(status.state).pipe(
    Stream.runForEach((state) =>
      Effect.gen(function* () {
        if (state.type !== "ready") return
        const baseURL = (yield* connection(ctx, instance)).ANTHROPIC_BASE_URL ?? io.env().ANTHROPIC_BASE_URL
        const checked = state.full === true || current.catalog.checked === true
        const next: Catalog = {
          priceSource: priceSource(state.probe.account, baseURL),
          models: nextModels(state.probe.models, current.catalog.models, state.full === true),
          ...(checked ? { checked } : {}),
        }
        if (JSON.stringify(next) === JSON.stringify(current.catalog)) return
        current.catalog = next
        yield* storage.set(CATALOG_KEY, current.catalog)
        yield* ctx.provider.reload()
        if (unmeasured(next.models)) yield* status.refresh().pipe(Effect.forkScoped)
      }),
    ),
    Effect.forkScoped,
  )

  // Without a saved list there is no model to pick, so the first message that would fill it can never be sent.
  const empty = current.catalog.models.length === 0
  const usable = instance.token() !== undefined || (yield* ctx.integration.connection.active(ID)) !== undefined
  const unchecked = current.catalog.checked !== true
  if ((empty || unchecked || unmeasured(current.catalog.models)) && usable) {
    yield* status.refresh().pipe(Effect.forkScoped)
  }
})

// The instance's own token and folder, overridden by anything set for the provider in opencode.json.
export const connection = Effect.fn("ClaudeProvider.connection")(function* (
  ctx: Context,
  instance: ClaudeInstance.Instance,
) {
  // A pool checks its login and lists models with its first account
  const first = instance.members?.()[0]
  const own = first ? { ...first.env } : ClaudeInstance.env(instance)
  const provider = yield* ctx.provider.get({ providerID: instance.id }).pipe(Effect.option)
  if (Option.isNone(provider)) return own
  const info = provider.value.data
  return {
    ...own,
    ...ClaudeQueryOptions.connectionEnv({ settings: info.settings, headers: info.headers, body: info.body }),
  }
})

/**
 * The model list after a report from Claude Code. Only the full check replaces it: a chat's startup report lists just
 * Claude Code's aliases and the chat's own model, so it may only add models the list doesn't have yet.
 */
export function nextModels(
  models: readonly ClaudeProbe.Model[],
  saved: readonly CatalogModel[],
  full: boolean,
): CatalogModel[] {
  const reported = fromClaude(models, saved)
  if (full || saved.length === 0) return reported
  const known = new Set(saved.map((model) => model.id))
  return [...saved, ...reported.filter((model) => !known.has(model.id))]
}

// Context windows only come from the full check, so a chat's startup report keeps the saved ones.
function fromClaude(models: readonly ClaudeProbe.Model[], saved: readonly CatalogModel[]): CatalogModel[] {
  const known = new Map<string, number | undefined>()
  for (const model of saved) known.set(model.id, model.contextWindow)
  const result: CatalogModel[] = []
  for (const model of models) {
    // "default" follows Claude Code's own default, which can change under a running opencode session
    if (model.value === "default") continue
    result.push({
      id: model.value,
      name: model.displayName,
      efforts: model.supportedEffortLevels ?? [],
      contextWindow: model.contextWindow ?? known.get(model.value),
      resolvedModel: model.resolvedModel,
    })
  }
  return result
}

// A subscription covers usage, and a custom base URL or an enterprise gateway can bill anything, so they show no cost.
function priceSource(account: AccountInfo, baseURL: string | undefined) {
  if (baseURL) return
  if (account.apiProvider === undefined) return
  if (account.apiProvider === "firstParty" && account.apiKeySource === undefined) return
  return PRICE_SOURCES[account.apiProvider]
}

function toModel(
  ID: Provider.ID,
  model: CatalogModel,
  prices: ReadonlyMap<string, Model.Info> | undefined,
): Model.Info {
  const defaults = Model.Info.default(ID, Model.ID.make(model.id))
  // The 1M context version's price tiers are on the base model
  const id = (model.resolvedModel ?? model.id).replace(/\[1m\]$/, "")
  // Mantle names models `anthropic.claude-…`, and Vertex lists current models as `claude-…@default`
  const priced = prices?.get(id) ?? prices?.get(id.replace(/^anthropic\./, "")) ?? prices?.get(`${id}@default`)
  return {
    ...defaults,
    name: model.name,
    // The SDK reports context windows before a prompt, but not output limits. 0 means unknown in OpenCode.
    limit: { context: model.contextWindow ?? defaults.limit.context, output: 0 },
    // OpenCode picks the title model by family (Model.small).
    family: model.id.includes("haiku") ? Model.Family.make("claude-haiku") : undefined,
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { effort } })),
    cost: priced?.cost ?? [],
  }
}
