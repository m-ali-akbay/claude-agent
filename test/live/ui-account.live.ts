// Manual check against the real `claude`, with an isolated database:
//   CLAUDE_TOKEN_FILES=~/tokens/work,~/tokens/home bun test/live/ui-account.live.ts "$(mktemp -d)"
// Each file becomes a Claude Account named after the file. With two or more, the chat runs on claude-pool.
import { Integration, Model, Provider } from "@opencode/plugin/effect"
import { OpenCode } from "@opencode/sdk/effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schedule } from "effect"
import { ClaudeIO } from "../../src/claude/io.js"
import { make, Registries } from "../../src/index.js"
import { ClaudeConnected } from "../../src/plugin/connected.js"

const directory = process.argv[2]!
const files = (process.env.CLAUDE_TOKEN_FILES ?? process.env.CLAUDE_TOKEN_FILE ?? "").split(",").filter(Boolean)
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
  for (const file of files) {
    yield* opencode.integration.connect.key({
      integrationID: Integration.ID.make(ClaudeConnected.HUB_ID),
      key: readFileSync(file, "utf8").trim(),
      answer: { name: path.basename(file) },
    })
  }
  const providerID =
    files.length >= 2 ? ClaudeConnected.POOL_ID : `claude-${ClaudeConnected.slug(path.basename(files[0]!))}`
  const models = yield* opencode.model.list().pipe(
    Effect.map((l) => l.data.filter((m) => String(m.providerID) === providerID).map((m) => String(m.id))),
    Effect.repeat({ until: (ids) => ids.includes("haiku"), schedule: Schedule.spaced("500 millis") }),
    Effect.timeout("90 seconds"),
  )
  const providers = yield* opencode.provider.list()
  console.log("providers:", providers.data.map((p) => `${p.id} (${p.name})`).join(", "))
  console.log(`${providerID} models:`, models.join(", "))
  const result = yield* opencode.generate.text({
    prompt: "Reply with exactly: OK-UI",
    model: Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make("haiku") }),
  })
  console.log("reply:", result.text)
})
await Effect.runPromise(Effect.scoped(program))
process.exit(0)
