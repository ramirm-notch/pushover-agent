# Working here

Pushover Agent is a dependency-free Node CLI: agent lifecycle JSON/flags → notification → Pushover → mobile device. It has no web UI, database, worker, or MCP service. Transcript files are optional, read-only input.

## Code map

- `plugins/pushover-agent/scripts/pushover-notify.mjs`: parsing, classification, conversation links, HTTP delivery, and failure handling.
- `plugins/pushover-agent/hooks.json`: Codex hooks; `plugins/pushover-agent/hooks/claude-hooks.json`: Claude hooks. Keep adapters thin and host identity explicit.
- `.agents/plugins/marketplace.json`: Codex catalog. Plugin manifests and the Claude catalog live inside `plugins/pushover-agent/`.
- `plugins/pushover-agent/test/notifier.test.mjs`: CLI, declared hooks, package paths, and loopback HTTP regression tests.

## Boundaries

- Keep credentials in runtime environment variables; tests use fake credentials and local HTTP only. Delivery errors must remain non-blocking unless `PUSHOVER_FAIL_HARD=1`.
- A local Codex deep link is not a public mobile share URL. Use host-provided URLs or configured templates; never invent a sharing service.
- Preserve user work and existing regression coverage. Do not merge, deploy, publish, or change installed plugins without authorization.

## Complete the change

One owner traces and integrates the user outcome. Delegate only bounded independent work that saves effort; no recursive delegation or repeated reviews without new evidence. Fix shared causes and keep optional cleanup separate.

From the repository root, run `npm --prefix plugins/pushover-agent test`. No install or build is needed. Tests require loopback networking; report a sandbox denial instead of skipping HTTP coverage.

Use [CONTRIBUTING.md](CONTRIBUTING.md) for the outcome trace, risk-based checks, and live verification limits; use the [product README](plugins/pushover-agent/README.md) for setup and configuration. For manifest/install changes, load the available `plugin-creator` skill and verify host schemas. Core notifier edits need no extra skill; add one only for a demonstrated recurring workflow.
