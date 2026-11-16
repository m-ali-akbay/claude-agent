import { describe, expect, test } from "bun:test"
import type { ClaudeProbe } from "../../src/claude/probe.js"
import { ClaudeProvider } from "../../src/plugin/provider.js"

const reported = (...ids: string[]): ClaudeProbe.Model[] =>
  ids.map((id) => ({ value: id, displayName: id.toUpperCase(), description: "", supportedEffortLevels: [] }))
const saved = (...ids: string[]): ClaudeProvider.CatalogModel[] =>
  ids.map((id) => ({ id, name: id.toUpperCase(), efforts: [], contextWindow: 200000 }))

describe("model list", () => {
  test("the full check replaces the list", () => {
    const next = ClaudeProvider.nextModels(reported("opus", "haiku"), saved("opus", "sonnet", "claude-opus-4-6"), true)
    expect(next.map((model) => model.id)).toEqual(["opus", "haiku"])
    // Context windows the check did not measure are kept
    expect(next[0]!.contextWindow).toBe(200000)
  })

  test("a chat's startup report, which lists fewer models, only adds new ones", () => {
    const list = saved("opus", "sonnet", "haiku", "claude-opus-4-6", "claude-sonnet-4-6")
    const next = ClaudeProvider.nextModels(reported("default", "sonnet", "claude-fable-5-2[1m]"), list, false)
    expect(next.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-fable-5-2[1m]",
    ])
  })

  test("an empty list takes whatever is reported first", () => {
    expect(ClaudeProvider.nextModels(reported("opus", "sonnet"), [], false).map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
    ])
  })
})
