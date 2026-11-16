// Manual check: CLAUDE_TOKEN_FILE=… bun test/live/ui-account.live.ts <empty dir>
import { Integration, Model, Provider } from "@opencode/plugin/effect"
import { OpenCode } from "@opencode/sdk/effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schedule } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { make, Registries } from "../../src/index.js"

const directory = process.argv[2]!
const token = readFileSync(process.env.CLAUDE_TOKEN_FILE!, "utf8").trim()
const plugin = make(ClaudeIO.real, new Registries())
const program = Effect.gen(function* () {
  const opencode = yield* OpenCode.create({
    database: { path: path.join(directory, "db.sqlite") },
    config: { directory, project: false, content: "{}" },
    models: { fetch: false },
    fs: { filewatcher: false },
    plugins: [{ ...plugin, effect: (ctx) => plugin.effect({ ...ctx, options: { accounts: {} } }) }],
  })
  yield* opencode.model.list()
  yield* opencode.integration.connect.key({
    integrationID: Integration.ID.make("claude-account"),
    key: token,
    label: "Şuheyda",
  })
  const models = yield* opencode.model.list().pipe(
    Effect.map((l) => l.data.filter((m) => String(m.providerID) === "claude-suheyda").map((m) => String(m.id))),
    Effect.repeat({ until: (ids) => ids.includes("haiku"), schedule: Schedule.spaced("500 millis") }),
    Effect.timeout("90 seconds"),
  )
  console.log("models:", models.join(", "))
  const result = yield* opencode.generate.text({
    prompt: "Reply with exactly: OK-UI",
    model: Model.Ref.make({ providerID: Provider.ID.make("claude-suheyda"), id: Model.ID.make("haiku") }),
  })
  console.log("reply:", result.text)
})
await Effect.runPromise(Effect.scoped(program))
process.exit(0)
