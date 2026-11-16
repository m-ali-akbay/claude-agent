# opencode-claude-multi

An opencode provider plugin that runs Claude models through Claude Code (the Claude Agent SDK), like the bundled
`claude-agent` provider, but lets you add **the same provider several times, each with its own Claude Code OAuth
token**. Every account shows up as its own provider (`claude-ali/opus`, `claude-work/sonnet`, …) with its own model
list, its own `claude` processes and its own saved sessions.

It is a fork of [R44VC0RP/claude-agent](https://github.com/R44VC0RP/claude-agent) (the `upstream` remote). Everything
upstream does (tools, sync, forks, fast mode, effort variants, `configDir` rotation) still works per account.

## Install

Requires OpenCode 2.2.3+ and Claude Code (`claude`) on `PATH`.

1. Create a long-lived OAuth token for each account. Sign in to that account in the browser when asked:

   ```sh
   claude setup-token
   ```

   Save each token (`sk-ant-oat01-…`) in its own file, readable only by you:

   ```sh
   mkdir -p ~/.config/opencode/claude-accounts && chmod 700 ~/.config/opencode/claude-accounts
   pbpaste > ~/.config/opencode/claude-accounts/work && chmod 600 ~/.config/opencode/claude-accounts/work
   ```

2. Add the plugin to `~/.config/opencode/opencode.json` with one entry per account under `accounts`. The key is the
   provider ID:

   ```json
   {
     "plugins": [
       "-opencode.provider.claude-agent",
       {
         "package": "/path/to/opencode-claude-multi",
         "options": {
           "accounts": {
             "claude-home": { "name": "Claude · Home", "tokenFile": "~/.config/opencode/claude-accounts/home" },
             "claude-work": { "name": "Claude · Work", "tokenFile": "~/.config/opencode/claude-accounts/work" }
           }
         }
       }
     ]
   }
   ```

   `"-opencode.provider.claude-agent"` turns off the bundled single-account provider. It's optional.

3. Start OpenCode. Each account checks its login and fills its model list within a few seconds; then pick
   `claude-home/opus`, `claude-work/sonnet`, … in `/models`. No `/connect` is needed for accounts with a token.

## Add accounts from the UI

No config editing needed: the plugin lists a **Claude Account** provider. Connect it (`/connect` → **Claude Account**,
or the providers settings in the desktop app), choose **Claude Code OAuth token (claude setup-token)**, enter an
**Account name** and paste the token. Every saved token becomes a provider of its own, named after the account: the name
`Şuheyda` gives `claude-suheyda`, shown as **Claude · Şuheyda** (a leading "Claude" is dropped from the ID, so
`Claude Work` is `claude-work`). Add as many as you like.

To rename an account later, rename its credential in OpenCode (in the TUI: `/connect` → **Claude Account** → select the
token → **rename**). The provider follows the new name while OpenCode runs; removing the token removes the provider.
Chats started under the old name keep their history, but a new model pick is needed since the provider ID changed.
A name already used by an `accounts` entry gets a short suffix.

To hide the Claude Account provider, set `"connected": false` in the plugin's options.

## Account options (opencode.json)

| Option      | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `name`      | Display name in `/models`. Default `Claude · <id>`.                                               |
| `tokenFile` | File holding only the OAuth token. Re-read for each new model, so you can swap it without restart. |
| `tokenEnv`  | Environment variable holding the token.                                                           |
| `token`     | The token inline. Avoid: it puts a secret in `opencode.json`.                                     |
| `configDir` | A Claude Code config folder (`CLAUDE_CONFIG_DIR`). Without a token, its `claude auth login` is used. |

Per-provider settings in `providers.<id>` still apply on top (for example `settings.fast`, `settings.baseURL`, custom
model entries), and `settings.oauthToken` there overrides the account's token.

Without `accounts`, the plugin registers a single `claude-agent` provider and behaves exactly like upstream.

## How it works

- Each account is a separate opencode provider, registered by one plugin instance. Accounts from `accounts` also get
  an integration of their own; accounts from the UI are the credentials of the single `claude-account` integration.
- Requests run `claude` with `CLAUDE_CODE_OAUTH_TOKEN` set to the account's token. `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` inherited from the shell are dropped for those processes, because
  Claude Code would otherwise prefer them over the account's token.
- Model catalogs, Claude session records and rate-limit state are stored per account (storage keys prefixed with the
  provider ID).
- Message metadata still uses the `claude-agent` key, so a chat moved between accounts reads its earlier tool results.

## Develop

```sh
bun install
bun run typecheck
bun test test/opencode test/claude test/sync test/tools test/language-model
```

`test/opencode/accounts.test.ts` covers both kinds of accounts with a fake `claude`. `test/live/ui-account.live.ts`
checks the UI flow against the real `claude` with an isolated database:

```sh
CLAUDE_TOKEN_FILE=~/.config/opencode/claude-accounts/work bun test/live/ui-account.live.ts "$(mktemp -d)"
```
