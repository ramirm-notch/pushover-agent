# Pushover Agent

Pushover Agent sends mobile notifications when Codex ends a session or waits for user action. It supports Codex, Claude Code, and Cursor directly and exposes a host-neutral command that any agent with lifecycle hooks can call.

Codex alerts once per thread when its session ends (`SessionEnd`), and once for each distinct approval request (`PermissionRequest`) or turn that ends asking you for input (`Stop`). Tool progress, optional offers in a final answer, and ordinary turn endings stay silent. A session ends when Codex closes or the conversation is archived or deleted. An idle session can also end after 30 minutes with no client viewing it. Claude Code, Cursor, and generic hosts keep their existing notification behavior.

The notification contains the agent's last message, the project name, and a conversation URL when available. The same URL is also set as Pushover's **Open conversation** action.

Commands below run from the repository root, which contains `plugins/pushover-agent/`. For development and verification boundaries, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Requirements

- Node.js 18 or newer
- A Pushover application/API token
- A Pushover user or group key

Export the credentials in the environment that launches your agent:

```sh
export PUSHOVER_API_TOKEN="your-application-token"
export PUSHOVER_USER_KEY="your-user-or-group-key"
```

The shorter aliases `PUSHOVER_TOKEN` and `PUSHOVER_USER` are also accepted. Credentials are read only at runtime and are never stored in the plugin.

To use a separate Pushover application per host, export `PUSHOVER_API_TOKEN_CC` (Claude Code), `PUSHOVER_API_TOKEN_CODEX` (Codex), and/or `PUSHOVER_API_TOKEN_CURSOR` (Cursor). For any other host the notifier checks `PUSHOVER_API_TOKEN_<HOST>`, where `<HOST>` is the `--host` name upper-cased with other characters replaced by `_` (`my-agent` → `PUSHOVER_API_TOKEN_MY_AGENT`). A per-host token wins over `PUSHOVER_API_TOKEN`. The user key is shared.

The Claude Code desktop app does not load your shell profile, so exports in `~/.zshrc` do not reach its hooks. Other desktop apps, including Cursor, may behave the same way; if alerts never arrive, launch the app from a shell that has the variables exported. Add the same values to the `env` block of `~/.claude/settings.json` as well:

```json
"env": {
  "PUSHOVER_API_TOKEN_CC": "your-claude-application-token",
  "PUSHOVER_USER_KEY": "your-user-or-group-key"
}
```

Check the local setup without sending an alert:

```sh
node plugins/pushover-agent/scripts/pushover-notify.mjs --check
```

Add `--host Codex`, `--host Cursor`, or another host name to check that host's token. This checks credential presence, API endpoint syntax, supported priority, and the active conversation URL or template. It never prints configuration values, reads stdin or transcripts, or makes network requests. Templates are checked with sample identifiers; actual identifiers are checked when a hook runs. Success does not prove that credentials are accepted, a host is installed, or a phone receives notifications. Missing or invalid configuration exits with code 1, independently of `PUSHOVER_FAIL_HARD`.

Use `node plugins/pushover-agent/scripts/pushover-notify.mjs --help` for the supported flags. Unknown flags, missing flag values, and invalid `--payload` JSON objects exit with code 2 without sending an alert.

## Conversation links

If a hook provides `conversation_url`, `share_url`, or `web_url`, the plugin uses it automatically. You can also set a fixed URL:

```sh
export PUSHOVER_CONVERSATION_URL="https://example.com/my-agent"
```

For per-conversation HTTPS links that open from any mobile device, set a template supplied by your agent host or remote-access service:

```sh
export PUSHOVER_CONVERSATION_URL_TEMPLATE='https://agents.example/conversations/{session_id}'
```

Supported placeholders are `{session_id}`, `{thread_id}`, `{turn_id}`, and `{host}`. Values are URL-encoded. Local Codex turns fall back to `codex://threads/{thread_id}`; this opens the installed Codex app but is not a public web share link. A local agent cannot create an internet-accessible conversation URL by itself, so use an HTTPS template or a hook-provided share URL when access from anywhere is required.

Links must be absolute web or application URLs in `scheme://host/...` form, with no embedded username/password, whitespace, or unresolved placeholders. Executable schemes and local-file links are rejected. Links exceeding [Pushover's 512-character limit](https://pushover.net/api#limits) are omitted rather than truncated. A template with an unknown placeholder or a missing required identifier is also omitted. These cases produce a warning without printing the URL and still deliver the message without a conversation action. Invalid supplied links do not fall back to a different conversation.

## Install in Codex

From the repository root:

```sh
codex plugin marketplace add .
codex plugin add pushover-agent@personal
```

Restart the Codex desktop app after installation. In the Codex CLI, open `/hooks` to review and trust the `SessionEnd`, `Stop`, and `PermissionRequest` hooks, then start a new task. Codex can ask you to review a hook again when its definition changes.

Versions before 0.2.0 did not declare their hooks to Codex, so Codex never ran them. To upgrade, run `codex plugin add pushover-agent@personal` again, then restart Codex and start a new task.

Install the plugin from one Codex marketplace. Keep `pushover-agent@personal` and remove the duplicate Codex plugin and marketplace with `codex plugin remove pushover-agent@pushover-agent` and `codex plugin marketplace remove pushover-agent`. This does not remove the Claude Code installation.

Copies of 0.2.4 and newer running under the same local user and temporary directory share empty deduplication markers. Codex supplies the thread and turn identifiers. A completion marker is kept for the thread until the system clears the temporary files. An explicit HTTP client error allows a later invocation to send the event again. After a timeout or lost connection the marker stays because Pushover may have received the request.

## Install in Claude Code

From the repository root, run these as two separate prompts:

```text
/plugin marketplace add ./plugins/pushover-agent
/plugin install pushover-agent@pushover-agent
```

The `Stop` hook handles both final responses and questions. `PermissionRequest` and permission/idle notifications alert immediately when Claude is waiting for action.

Claude Code caches plugins by version. To upgrade an existing install, run `/plugin marketplace update pushover-agent`, then `/plugin install pushover-agent@pushover-agent` again and start a new session. Cursor runs this copy too (see [Install in Cursor](#install-in-cursor)), and copies older than 0.2.0 label Cursor alerts as Claude Code.

## Install in Cursor

Cursor loads local plugins from `~/.cursor/plugins/local` and rejects symlinks that point outside that folder, so copy the plugin there:

```sh
mkdir -p ~/.cursor/plugins/local
cp -R plugins/pushover-agent ~/.cursor/plugins/local/pushover-agent
```

Restart Cursor. Copy the folder again after updating it.

Cursor can also load plugins installed in Claude Code, and then uses this plugin's Cursor hooks when it does. If Pushover Agent is installed in Claude Code, do not copy it into `~/.cursor/plugins/local` as well, or Cursor sends each alert twice.

Cursor only exposes a `stop` hook. Questions in the final message alert as “needs input”, and cancelled or failed turns alert as “stopped”. Cursor has no hook for permission prompts, so those do not alert.

## Other agents

Configure the host's completion/input lifecycle hook to pipe a JSON object to:

```sh
node /absolute/path/to/PluginPushover/plugins/pushover-agent/scripts/pushover-notify.mjs
```

The generic input fields are `event`, `host`, `message`, `conversation_url`, `session_id`, `thread_id`, `turn_id`, and `cwd`. Set `event` to `completed`, `input`, or `stopped`; `input` explicitly requests an alert even when the message is not phrased as a question. Supply `host` so a launching agent's environment does not determine the sender. The `--event`, `--host`, `--message`, and `--url` flags override their JSON equivalents:

Explicit `completed`, `input`, and `stopped` events take precedence over message wording and notification metadata. Event selection uses `--event`, then JSON `event`, then host lifecycle fields. Question detection still handles `Stop` events and messages with no event. `--payload '{"session_id":"example"}'` supplies additional JSON fields and overrides stdin fields.

```sh
node plugins/pushover-agent/scripts/pushover-notify.mjs \
  --event input \
  --host my-agent \
  --message "Select a deployment target." \
  --url "https://example.com/conversation/123"
```

Codex's legacy `notify` setting passes a turn-complete event as one JSON argument. This route alerts only when the current final message asks for input. Use the plugin hooks for approval requests and session completion.

```toml
notify = ["node", "/absolute/path/to/PluginPushover/plugins/pushover-agent/scripts/pushover-notify.mjs"]
```

This makes the notification engine portable, but each agent must expose a lifecycle hook. Hosts without completion/input hooks cannot trigger any plugin automatically.

## Optional settings

| Variable | Purpose |
| --- | --- |
| `PUSHOVER_DEVICE` | Limit delivery to one Pushover device. |
| `PUSHOVER_SOUND` | Select a Pushover sound. |
| `PUSHOVER_PRIORITY` | Use `-2`, `-1`, `0`, or `1`. Emergency priority `2` requires retry/expiry settings that this plugin does not support. |
| `PUSHOVER_TITLE_PREFIX` | Prefix every notification title. |
| `PUSHOVER_NOTIFY_SUBAGENTS=1` | Enable notifications for subagent events passed by generic hosts. |
| `PUSHOVER_DRY_RUN=1` | Print the normalized notification without sending it. |
| `PUSHOVER_FAIL_HARD=1` | Return a failure exit code if notification delivery fails. |
| `PUSHOVER_API_URL` | Override the API endpoint, primarily for testing. |

Delivery failures are non-blocking by default: the agent continues even if Pushover is unavailable.

## Verify

```sh
npm --prefix plugins/pushover-agent test
PUSHOVER_DRY_RUN=1 node plugins/pushover-agent/scripts/pushover-notify.mjs --event input --host my-agent --message "Select a deployment target."
```

The suite uses fake credentials and a local HTTP server; it sends no mobile notifications. A dry-run previews the notification without contacting Pushover. See [live verification limits](../../CONTRIBUTING.md#trace-the-changed-path) before claiming that an installed host or phone flow works.
