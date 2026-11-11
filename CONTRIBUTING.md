# Developing Pushover Agent

## Start with one observable outcome

For example: a generic host emits `event=input` with “Select a deployment target.” and a conversation URL. Pushover receives a “needs input” title, that message, and the same URL as its **Open conversation** action, even without a question mark. A rejected delivery warns without blocking the host; strict mode exits unsuccessfully.

Before editing, reproduce the outcome and follow its callers through the shared notifier. Keep one owner responsible for the final result. Small fixes need a short plan and a failing regression, not an orchestration system. If a check repeatedly fails, inspect its cause before retrying.

## Setup and essential checks

Install Node.js 18+ and npm. There are no dependencies, build step, credentials, or host installations required for the automated suite. From the repository root:

```sh
npm --prefix plugins/pushover-agent test
```

This is also the command in [CI](.github/workflows/test.yml). CI exercises Node 18 (the declared minimum) and 24. The tests isolate host/credential settings, run the real CLI and declared hook commands, resolve both marketplace paths, and capture HTTP requests with a loopback server. They retain the completion, question, permission, and credential-free dry-run regressions.

If a sandbox returns `listen EPERM`, allow loopback networking for this command or run it in a normal terminal. Do not remove or skip the delivery tests to obtain a green result.

For a credential-free manual input alert preview:

```sh
PUSHOVER_DRY_RUN=1 node plugins/pushover-agent/scripts/pushover-notify.mjs \
  --event input --host my-agent --message "Select a deployment target." \
  --url "https://example.com/conversation/123"
```

Expect JSON with `state: "input"`, `host: "my-agent"`, a “needs input” title, and the supplied URL. Dry-run prints content: use synthetic text when sharing output.

## Trace the changed path

1. **Interface:** generic JSON stdin/CLI flags, or the relevant Codex/Claude hook declaration. Exercise the entry point being changed; do not stop at an internal helper.
2. **Core:** `main()` → `notification()` → message/event/host classification and URL selection in `scripts/pushover-notify.mjs`. All adapters share this path.
3. **Files:** if `transcript_path` is involved, exercise a temporary transcript. Transcripts are read-only. For Codex deduplication, exercise repeated hook processes with the same isolated temporary directory. The markers are empty files. There is no database or background worker.
4. **Service:** `requestPushover()` form-POSTs to Pushover; automated tests substitute a local HTTP endpoint with fake credentials and exercise acceptance and rejection.
5. **User:** actual host dispatch, Pushover delivery on a phone, and opening the intended conversation require a separately authorized live smoke test. Local HTTP success does not prove those outcomes.

## Match verification to risk

- For behavior changes, add the smallest regression that fails before the fix, rerun the suite, and repeat the failed user flow. Keep existing coverage unless its protection is demonstrably obsolete or redundant.
- For hook/packaging changes, the suite runs each manifest's declared hook commands; it is not a host schema validator. Bump the version in all three manifests and `package.json` together; hosts cache installs by version. For Codex, install into a temporary `CODEX_HOME` and confirm the app-server `hooks/list` method reports the plugin's hooks; the `plugin-creator` skill only scaffolds manifests and has no validator. Also run `claude plugin validate plugins/pushover-agent/.claude-plugin/plugin.json` and `claude plugin validate plugins/pushover-agent/.claude-plugin/marketplace.json` when Claude is available. Report unavailable host tools separately.
- For documentation changes, follow the commands from the directory they name and check links. Do not introduce new test tooling for prose.

Use the [product README](plugins/pushover-agent/README.md) as the single source for installation, credentials, settings, and conversation-link precedence. Installation is a separate action from source validation; changing a hook file here does not update an installed plugin. After an authorized installation, use a new host session to verify it.

Before handoff, review the diff and report the user outcome, checks passed/failed, unexercised boundaries, and blockers separately from optional improvements. A failing relevant regression or broken package path blocks the change. Missing phone evidence blocks a claim of live delivery, not a clearly scoped local fix. Verify Git status and branch before claiming merge readiness; a source copy without `.git` has no branch or remote evidence. Stop once the scoped outcome is verified; merge and release still require authorization.
