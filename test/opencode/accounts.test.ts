import { describe, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Integration, Model, Provider } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { it } from "../lib/effect.js"
import { FakeClaude } from "../lib/fake-claude.js"
import { FakeIO } from "../lib/fake-io.js"
import { TestOpenCode } from "../lib/opencode.js"

const providerModels = (opencode: TestOpenCode.Client, providerID: string) =>
  opencode.model
    .list()
    .pipe(Effect.map((list) => list.data.filter((m) => String(m.providerID) === providerID).map((m) => String(m.id))))

describe("several Claude accounts", () => {
  it.live("registers one provider per account, each running Claude with its own OAuth token", () =>
    Effect.gen(function* () {
      const folder = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "claude-multi-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
      )
      const tokenFile = path.join(folder, "work")
      yield* Effect.promise(() => writeFile(tokenFile, "sk-ant-oat01-work\n"))

      const claude = FakeClaude.make(
        [
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
          FakeClaude.expectStartup(),
          FakeClaude.expectTurn(),
          FakeClaude.expectInterrupt(),
        ],
        { probes: true },
      )
      const test = yield* TestOpenCode.start({
        // A key and a token from the shell would outrank the account's own token, so they must not reach Claude.
        io: FakeIO.make({
          claude,
          env: { ANTHROPIC_API_KEY: "sk-ant-api-shell", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-shell", HOME: "/h" },
        }),
        options: {
          accounts: {
            "claude-home": { name: "Claude · Home", token: "sk-ant-oat01-home" },
            "claude-work": { name: "Claude · Work", tokenFile },
          },
        },
      })

      // Accounts with a token need no /connect: each checks its login and lists its own models.
      yield* TestOpenCode.waitUntil(
        Effect.all([providerModels(test.opencode, "claude-home"), providerModels(test.opencode, "claude-work")]),
        ([home, work]) => home.includes("haiku") && work.includes("haiku"),
        "30 seconds",
      )
      const providers = yield* test.opencode.provider.list()
      const names = providers.data.map((p) => [String(p.id), p.name])
      expect(names).toContainEqual(["claude-home", "Claude · Home"])
      expect(names).toContainEqual(["claude-work", "Claude · Work"])
      expect(names.map(([id]) => id)).not.toContain("claude-agent")

      const probes = claude.runs.map((run) => run.env.CLAUDE_CODE_OAUTH_TOKEN).sort()
      expect(probes).toEqual(["sk-ant-oat01-home", "sk-ant-oat01-work"])

      for (const [providerID, token] of [
        ["claude-home", "sk-ant-oat01-home"],
        ["claude-work", "sk-ant-oat01-work"],
      ] as const) {
        const before = claude.runs.length
        const result = yield* test.opencode.generate.text({
          prompt: "hello",
          model: Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make("haiku") }),
        })
        expect(result.text).toBe("COPPER-OTTER")
        const chat = claude.runs.slice(before).find((run) => run.args.includes("--include-partial-messages"))!.env
        expect(chat.CLAUDE_CODE_OAUTH_TOKEN).toBe(token)
        expect(chat.ANTHROPIC_API_KEY).toBeUndefined()
      }
      claude.check()
    }),
  )
})

describe("Claude accounts added from the UI", () => {
  it.live("turns each OAuth token saved for Claude Account into its own provider, and drops it when removed", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(
        [FakeClaude.expectStartup(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()],
        { probes: true },
      )
      const test = yield* TestOpenCode.start({
        io: FakeIO.make({ claude, env: { ANTHROPIC_API_KEY: "sk-ant-api-shell" } }),
        options: { accounts: {} },
      })
      const providers = () =>
        test.opencode.provider.list().pipe(Effect.map((list) => list.data.map((p) => [String(p.id), p.name] as const)))

      const integrations = yield* test.opencode.integration.list()
      const hub = integrations.data.find((i) => String(i.id) === "claude-account")
      expect(hub?.name).toBe("Claude Account")
      const method = hub?.methods.find((m) => m.type === "key")
      expect(method?.form?.map((field) => field.key)).toEqual(["name"])
      // With no token saved, Claude Account is a provider to connect, not a connected one.
      expect((yield* providers()).map(([id]) => id)).not.toContain("claude-account")

      yield* test.opencode.integration.connect.key({
        integrationID: Integration.ID.make("claude-account"),
        key: "sk-ant-oat01-ui-one",
        // The connect dialog asks for the name in the token form and saves no label
        answer: { name: "Şuheyda" },
      })
      yield* test.opencode.integration.connect.key({
        integrationID: Integration.ID.make("claude-account"),
        key: "sk-ant-oat01-ui-two",
        // A label chosen on connect wins over the form's name
        answer: { name: "ignored" },
        label: "Claude Work",
      })
      yield* TestOpenCode.waitUntil(
        Effect.all([providerModels(test.opencode, "claude-suheyda"), providerModels(test.opencode, "claude-work")]),
        ([one, two]) => one.includes("haiku") && two.includes("haiku"),
        "30 seconds",
      )
      expect(yield* providers()).toContainEqual(["claude-suheyda", "Claude · Şuheyda"])
      expect(yield* providers()).toContainEqual(["claude-work", "Claude · Claude Work"])

      const before = claude.runs.length
      const result = yield* test.opencode.generate.text({
        prompt: "hello",
        model: Model.Ref.make({ providerID: Provider.ID.make("claude-suheyda"), id: Model.ID.make("haiku") }),
      })
      expect(result.text).toBe("COPPER-OTTER")
      const chat = claude.runs.slice(before).find((run) => run.args.includes("--include-partial-messages"))!.env
      expect(chat.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-ui-one")
      expect(chat.ANTHROPIC_API_KEY).toBeUndefined()

      const credentials = yield* test.opencode.credential.list()
      // Renaming the account in the UI renames its provider
      const one = credentials.find((c) => c.label === "Claude Account")!
      yield* test.opencode.credential.update({ credentialID: one.id, label: "Personal" })
      yield* TestOpenCode.waitUntil(
        Effect.all([providers(), providerModels(test.opencode, "claude-personal")]),
        ([list, models]) => !list.some(([id]) => id === "claude-suheyda") && models.includes("haiku"),
        "30 seconds",
      )
      expect(yield* providers()).toContainEqual(["claude-personal", "Claude · Personal"])

      const work = credentials.find((c) => c.label === "Claude Work")!
      yield* test.opencode.credential.remove({ credentialID: work.id })
      yield* TestOpenCode.waitUntil(providers(), (list) => !list.some(([id]) => id === "claude-work"), "10 seconds")
      expect((yield* providers()).map(([id]) => id)).toContain("claude-personal")
      claude.check()
    }),
  )
})
