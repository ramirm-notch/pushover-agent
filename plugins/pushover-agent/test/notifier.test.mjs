import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/pushover-notify.mjs", import.meta.url));
const pluginRoot = path.dirname(path.dirname(script));
const testEnv = {
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
  SystemRoot: process.env.SystemRoot,
};

function runScript(args, input, env, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command || process.execPath, command ? [] : [script, ...args], {
      env: { ...testEnv, ...env }, timeout: 5000, shell: Boolean(command),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`notifier exited ${code}: ${stderr}`));
    });
    if (input !== null) child.stdin.end(input || "");
  });
}

function cursorTranscript(text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pushover-agent-"));
  const file = path.join(directory, "transcript.jsonl");
  fs.writeFileSync(file, [
    { role: "user", message: { content: [{ type: "text", text: "Deploy it." }] } },
    { role: "assistant", message: { content: [{ type: "text", text }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: {} }] } },
    { type: "turn_ended", status: "success" },
  ].map((record) => JSON.stringify(record)).join("\n"));
  return file;
}

function cursorStop(overrides = {}) {
  return {
    conversation_id: "conversation-123",
    generation_id: "generation-123",
    session_id: "conversation-123",
    hook_event_name: "stop",
    status: "completed",
    loop_count: 0,
    cursor_version: "2.0.0",
    workspace_roots: ["/work/my-project"],
    transcript_path: cursorTranscript("Which deployment should I use?"),
    ...overrides,
  };
}

async function withReceiver(run, statusCode = 200) {
  const forms = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      forms.push(new URLSearchParams(body));
      response.writeHead(statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: statusCode === 200 ? 1 : 0 }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    return await run(forms, {
      PUSHOVER_API_TOKEN: "test-token",
      PUSHOVER_USER_KEY: "test-user",
      PUSHOVER_API_URL: `http://127.0.0.1:${port}/1/messages.json`,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function capture(payload, extraEnv = {}, statusCode = 200, args = []) {
  return withReceiver(async (forms, env) => {
    const result = await runScript(args, payload === null ? null : JSON.stringify(payload), { ...env, ...extraEnv });
    return { form: forms.at(-1), ...result };
  }, statusCode);
}

test("sends a question notification with a mobile URL", async () => {
  const { form } = await capture({
    hook_event_name: "Stop",
    session_id: "session 42",
    cwd: "/work/my-project",
    last_assistant_message: "Which deployment should I use?",
  }, {
    PUSHOVER_CONVERSATION_URL_TEMPLATE: "https://agents.example/s/{session_id}",
  });
  assert.equal(form.get("token"), "test-token");
  assert.match(form.get("title"), /needs input/);
  assert.equal(form.get("url"), "https://agents.example/s/session%2042");
  assert.match(form.get("message"), /Open conversation: https:\/\/agents\.example/);
});

test("Codex Stop completion does not notify for an ordinary turn end", async () => {
  const { stdout } = await runScript([], JSON.stringify({
    hook_event_name: "Stop",
    thread_id: "thread-123",
    cwd: "/work/my-project",
    last_assistant_message: "Implemented and verified the change.",
  }), { PUSHOVER_DRY_RUN: "1" });
  assert.equal(stdout, "");
});

test("Codex ignores tool progress, repeated Stop hooks and stale or optional questions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pushover-agent-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcript = path.join(directory, "transcript.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ role: "assistant", content: "Which deployment should I use?" }));
  const cases = [
    { hook_event_name: "PostToolUse", tool_name: "Bash" },
    { hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Which deployment should I use?" },
    { hook_event_name: "Stop", last_assistant_message: null, transcript_path: transcript },
    { hook_event_name: "Stop", last_assistant_message: "Atualizei o guia da pergunta ‘Should I retry?’ com um exemplo." },
    { hook_event_name: "Stop", last_assistant_message: "Tudo concluído. Quer que eu faça também a publicação?" },
  ];
  const results = await Promise.all(cases.map((event) => runScript(["--host", "Codex"], JSON.stringify({
    session_id: "thread-123", turn_id: "turn-123", ...event,
  }), { PUSHOVER_DRY_RUN: "1" })));
  assert.deepEqual(results.map(({ stdout, stderr }) => Boolean(stdout || stderr)), [false, false, false, false, false]);
});

test("Codex Stop alerts when its final message needs action in Portuguese", async () => {
  const { stdout } = await runScript(["--host", "Codex"], JSON.stringify({
    hook_event_name: "Stop", session_id: "thread-123", turn_id: "turn-123",
    last_assistant_message: "Os testes passaram.\n\nPreciso que você confirme a versão para publicar.",
  }), { PUSHOVER_DRY_RUN: "1" });
  assert.equal(JSON.parse(stdout).state, "input");
});

test("Codex SessionEnd sends a final session notification", async () => {
  const { stdout } = await runScript(["--host", "Codex"], JSON.stringify({
    hook_event_name: "SessionEnd",
    session_id: "session-123",
    cwd: "/work/my-project",
    reason: "other",
  }), { PUSHOVER_DRY_RUN: "1" });
  const notice = JSON.parse(stdout);
  assert.equal(notice.state, "complete");
  assert.match(notice.title, /Codex finished/);
  assert.equal(notice.url, "codex://threads/session-123");
  assert.match(notice.message, /session ended/i);
});

test("concurrent Codex plugin copies deliver each approval and session end once", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pushover-agent-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secondCopy = path.join(directory, "other-marketplace");
  fs.cpSync(pluginRoot, secondCopy, { recursive: true });
  const { hooks } = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks.json"), "utf8"));
  const session = { session_id: "thread-123", cwd: "/work/my-project" };
  const approval = {
    ...session, hook_event_name: "PermissionRequest", turn_id: "turn-123", tool_name: "Bash",
    tool_input: { command: "git push", description: "Approve the push." },
  };
  const end = { ...session, hook_event_name: "SessionEnd", reason: "other" };

  await withReceiver(async (forms, env) => {
    const isolatedEnv = { ...env, TMPDIR: directory, TMP: directory, TEMP: directory };
    const invoke = (event, root = pluginRoot) => runScript([], JSON.stringify(event), {
      ...isolatedEnv, PLUGIN_ROOT: root,
    }, hooks[event.hook_event_name][0].hooks[0].command);
    const sendCopies = (event) => Promise.all([pluginRoot, secondCopy, pluginRoot, secondCopy].map((root) => invoke(event, root)));

    await sendCopies(approval);
    assert.deepEqual(forms.map((form) => form.get("title")), ["Codex needs input — my-project"]);
    await invoke({ ...approval, tool_input: { command: "npm test" } });
    assert.equal(forms.length, 2, "a different approval in the same turn still alerts");
    await sendCopies(end);
    await invoke(end, secondCopy);
    assert.deepEqual(forms.map((form) => form.get("title")), [
      "Codex needs input — my-project", "Codex needs input — my-project", "Codex finished — my-project",
    ]);
    await invoke({ ...end, session_id: "thread-456" });
    assert.equal(forms.length, 4, "a different thread still gets its own completion alert");

    const question = "Which deployment should I use?";
    await Promise.all([
      invoke({ ...session, hook_event_name: "Stop", turn_id: "turn-456", last_assistant_message: question }),
      runScript([JSON.stringify({ type: "agent-turn-complete", "thread-id": session.session_id,
        "turn-id": "turn-456", "last-assistant-message": question, cwd: session.cwd })], null, isolatedEnv),
    ]);
    assert.equal(forms.length, 5, "a Stop and a legacy notify for the same question produce one alert");
    assert.match(forms.at(-1).get("title"), /Codex needs input/);
  });
});

test("an explicitly rejected Codex notification can be sent by a later invocation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pushover-agent-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { TMPDIR: directory, TMP: directory, TEMP: directory };
  const event = { hook_event_name: "SessionEnd", session_id: "thread-123", host: "Codex" };
  const { stderr } = await capture(event, env, 429);
  assert.match(stderr, /HTTP 429/);
  const { form } = await capture(event, env);
  assert.ok(form, "the rejected request must not suppress a later delivery");
  assert.equal((await capture(event, env)).form, undefined, "accepted deliveries stay deduplicated");
});

test("Codex Stop questions send an input notification", async () => {
  const { stdout } = await runScript([], JSON.stringify({
    hook_event_name: "Stop",
    thread_id: "thread-123",
    cwd: "/work/my-project",
    last_assistant_message: "Which deployment should I use?",
  }), { PUSHOVER_DRY_RUN: "1" });
  const notice = JSON.parse(stdout);
  assert.match(notice.title, /Codex needs input/);
  assert.equal(notice.url, "codex://threads/thread-123");
  assert.match(notice.message, /^Which deployment should I use\?/);
});

test("generic host completion notifications remain enabled", async () => {
  const { stdout } = await runScript([], JSON.stringify({
    event: "completed",
    host: "my-agent",
    message: "Implemented and verified the change.",
    cwd: "/work/my-project",
  }), { PUSHOVER_DRY_RUN: "1" });
  const notice = JSON.parse(stdout);
  assert.equal(notice.title, "my-agent finished — my-project");
  assert.match(notice.message, /Implemented and verified/);
});

test("Codex subagent completion alerts remain available when explicitly enabled", async () => {
  const { stdout } = await runScript([], JSON.stringify({
    event: "SubagentStop",
    host: "Codex",
    message: "Subagent finished its review.",
  }), { PUSHOVER_DRY_RUN: "1", PUSHOVER_NOTIFY_SUBAGENTS: "1" });
  assert.equal(JSON.parse(stdout).state, "complete");
});

test("sends permission requests immediately", async () => {
  const { form } = await capture({
    hook_event_name: "PermissionRequest",
    host: "Claude Code",
    cwd: "/work/my-project",
    message: "Review this network request.",
  });
  assert.match(form.get("title"), /needs input/);
});

test("dry-run does not require credentials", async () => {
  const { stdout } = await runScript(["--event", "completed", "--message", "Done"], "", {
    PUSHOVER_API_TOKEN: "",
    PUSHOVER_TOKEN: "",
    PUSHOVER_USER_KEY: "",
    PUSHOVER_USER: "",
    PUSHOVER_DRY_RUN: "1",
  });
  assert.equal(JSON.parse(stdout).state, "complete");
});

test("generic input events send an input alert without guessing from punctuation", async () => {
  const { form } = await capture({
    event: "input",
    host: "my-agent",
    cwd: "/work/my-project",
    message: "Select a deployment target.",
    conversation_url: "https://agents.example/conversations/123",
  });
  assert.equal(form.get("title"), "my-agent needs input — my-project");
  assert.match(form.get("message"), /Select a deployment target\./);
  assert.equal(form.get("url"), "https://agents.example/conversations/123");
  assert.equal(form.get("url_title"), "Open conversation");
});

test("CLI input events override payload events and do not borrow a Codex conversation", async () => {
  const { stdout } = await runScript([
    "--event", "input", "--host", "my-agent", "--message", "Select a deployment target.",
  ], JSON.stringify({ event: "completed" }), {
    PUSHOVER_DRY_RUN: "1",
    CODEX_THREAD_ID: "unrelated-codex-thread",
  });
  const notice = JSON.parse(stdout);
  assert.equal(notice.state, "input");
  assert.equal(notice.host, "my-agent");
  assert.equal(notice.url, "");
});

test("delivery failures warn without blocking; strict mode fails", async () => {
  const { stderr } = await capture({ event: "input" }, {}, 503);
  assert.match(stderr, /Pushover returned HTTP 503/);
  await assert.rejects(capture({ event: "input" }, { PUSHOVER_FAIL_HARD: "1" }, 503), /exited 1:.*HTTP 503/);
});

test("marketplaces resolve to the packaged plugin", () => {
  const repoRoot = path.resolve(pluginRoot, "../..");
  const codex = JSON.parse(fs.readFileSync(path.join(repoRoot, ".agents/plugins/marketplace.json"), "utf8"));
  const claude = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin/marketplace.json"), "utf8"));
  for (const [marketplace, root, manifestPath] of [
    [codex, repoRoot, ".codex-plugin/plugin.json"],
    [claude, pluginRoot, ".claude-plugin/plugin.json"],
  ]) {
    const entry = marketplace.plugins.find((plugin) => plugin.name === "pushover-agent");
    const source = path.resolve(root, entry.source.path || entry.source);
    assert.equal(source, pluginRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, manifestPath), "utf8"));
    assert.equal(manifest.name, entry.name);
  }
});

test("declared host hooks send input alerts with the correct host and conversation", async () => {
  for (const [host, manifestPath, events] of [
    ["Codex", ".codex-plugin/plugin.json", ["SessionEnd", "Stop", "PermissionRequest"]],
    ["Claude Code", ".claude-plugin/plugin.json", ["Stop", "Notification", "PermissionRequest"]],
    ["Cursor", ".cursor-plugin/plugin.json", ["stop"]],
  ]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifestPath), "utf8"));
    assert.equal(typeof manifest.hooks, "string", `${manifestPath} must declare its hooks file`);
    const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, manifest.hooks), "utf8"));
    if (host === "Codex") assert.deepEqual(Object.keys(config.hooks).sort(), ["PermissionRequest", "SessionEnd", "Stop"]);
    for (const event of events) {
      const hooks = (config.hooks[event] || []).flatMap((group) => group.hooks ?? [group]);
      assert.ok(hooks.length, `${host} ${event} must have a hook`);
      if (host === "Codex") {
        assert.equal(hooks.length, 1, `${event} must run only one Pushover hook per installation`);
        assert.ok(hooks.every((hook) => !("statusMessage" in hook)), `${event} must not show a sending message before filtering`);
      }
      for (const hook of hooks) {
        assert.ok(
          !("async" in hook),
          `${host} ${event} must not declare async: the host kills the hook process before delivery completes`,
        );
        const payload = host === "Cursor" ? cursorStop() : {
          hook_event_name: event,
          session_id: "session-123",
          last_assistant_message: event === "Stop" ? "Which deployment should I use?" : "Review this network request.",
        };
        // Cursor exports both plugin-root variables, so it must not be mistaken for Claude Code.
        const { stdout } = await runScript([], JSON.stringify(payload), {
          PUSHOVER_DRY_RUN: "1",
          PLUGIN_ROOT: pluginRoot,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          ...(host === "Cursor" && { CURSOR_PLUGIN_ROOT: pluginRoot, CURSOR_VERSION: "2.0.0" }),
        }, hook.command);
        const notice = JSON.parse(stdout);
        assert.equal(notice.host, host, `${host} ${event} host`);
        assert.equal(notice.state, event === "SessionEnd" ? "complete" : "input", `${host} ${event} state`);
        assert.equal(notice.url, host === "Codex" ? "codex://threads/session-123" : "");
        if (host === "Cursor") {
          assert.equal(notice.title, "Cursor needs input — my-project");
          assert.match(notice.message, /^Which deployment should I use\?/);
        }
      }
    }
    if (host === "Codex") {
      const sessionEndHooks = config.hooks.SessionEnd.flatMap((group) => group.hooks ?? [group]);
      assert.ok(sessionEndHooks.every((hook) => hook.timeout <= 3), "SessionEnd must fit Codex's 3-second limit");
    }
  }
});

test("hook files avoid the hosts' default hooks/hooks.json path", () => {
  // Claude Code and Codex load hooks/hooks.json in addition to declared files, and Cursor would read it
  // for any manifest without a hooks field, so a file there would run with the wrong host format.
  assert.equal(fs.existsSync(path.join(pluginRoot, "hooks/hooks.json")), false);
});

test("plugin manifests share one name and version so installed caches refresh together", () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(pluginRoot, file), "utf8"));
  const { version } = read("package.json");
  for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    assert.equal(read(file).name, "pushover-agent", file);
    assert.equal(read(file).version, version, file);
  }
});

test("Cursor stop payloads use the transcript, workspace, and turn status without an explicit host", async () => {
  const { stdout } = await runScript([], JSON.stringify(cursorStop()), {
    PUSHOVER_DRY_RUN: "1", CLAUDE_PLUGIN_ROOT: pluginRoot,
  });
  const notice = JSON.parse(stdout);
  assert.equal(notice.title, "Cursor needs input — my-project");
  for (const status of ["aborted", "error"]) {
    const { stdout: stopped } = await runScript(["--host", "Cursor"], JSON.stringify(cursorStop({
      status, transcript_path: cursorTranscript("Ran the migration."),
    })), { PUSHOVER_DRY_RUN: "1" });
    assert.equal(JSON.parse(stopped).state, "stopped", status);
  }
});

test("Codex notify turn completion events do not pretend the session ended", async () => {
  const { stdout, stderr } = await runScript([JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-123",
    "turn-id": "turn-123",
    cwd: "/work/my-project",
    "input-messages": ["Ship it."],
    "last-assistant-message": "Implemented and verified the change.",
  })], null, { PUSHOVER_DRY_RUN: "1" });
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("Codex notify still alerts when the final message asks the user for input", async () => {
  const { stdout } = await runScript([JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-123",
    "turn-id": "turn-123",
    cwd: "/work/my-project",
    "last-assistant-message": "Which deployment should I use?",
  })], null, { PUSHOVER_DRY_RUN: "1" });
  const notice = JSON.parse(stdout);
  assert.equal(notice.state, "input");
  assert.match(notice.title, /Codex needs input/);
});

test("per-host application tokens override the shared token", async () => {
  for (const [host, env, token] of [
    ["Cursor", { PUSHOVER_API_TOKEN_CURSOR: "cursor-token" }, "cursor-token"],
    ["Codex", { PUSHOVER_API_TOKEN_CODEX: "codex-token" }, "codex-token"],
    ["Claude Code", { PUSHOVER_API_TOKEN_CC: "claude-token" }, "claude-token"],
    ["my-agent", { PUSHOVER_API_TOKEN_MY_AGENT: "generic-token" }, "generic-token"],
    ["other-agent", { PUSHOVER_API_TOKEN_CURSOR: "cursor-token" }, "shared-token"],
  ]) {
    const { form } = await capture({ event: "input", host }, { PUSHOVER_API_TOKEN: "shared-token", ...env });
    assert.equal(form.get("token"), token, host);
  }
  const { stdout } = await runScript(["--check", "--host", "Cursor"], null, {
    PUSHOVER_API_TOKEN_CURSOR: "cursor-token", PUSHOVER_USER_KEY: "test-user",
  });
  assert.match(stdout, /Local configuration checks passed/);
  // Without a host, --check must not borrow another host's token.
  await assert.rejects(runScript(["--check"], null, {
    PUSHOVER_API_TOKEN_CODEX: "codex-token", PUSHOVER_USER_KEY: "test-user",
  }), /exited 1:.*PUSHOVER_API_TOKEN/);
});

test("explicit events win over message guesses and incidental hook metadata", async () => {
  for (const event of ["completed", "input", "stopped"]) {
    const { stdout } = await runScript([], JSON.stringify({
      event,
      hook_event_name: "Stop",
      notification_type: "permission_prompt",
      message: 'Updated the documentation for "Should I retry".',
    }), { PUSHOVER_DRY_RUN: "1" });
    assert.equal(JSON.parse(stdout).state, event === "completed" ? "complete" : event);
  }
  const { stdout } = await runScript(["--event", "completed"], JSON.stringify({
    event: "input", message: "Which deployment should I use?",
  }), { PUSHOVER_DRY_RUN: "1" });
  assert.equal(JSON.parse(stdout).state, "complete");
  const { stdout: inferred } = await runScript([], 'Which deployment should I use?', { PUSHOVER_DRY_RUN: "1" });
  assert.equal(JSON.parse(inferred).state, "input");
});

test("help and configuration checks neither read stdin nor contact Pushover", async () => {
  for (const args of [["--help"], ["-h"], ["--check"]]) {
    const { form, stdout, stderr } = await capture(null, {
      PUSHOVER_DRY_RUN: "1",
      PUSHOVER_CONVERSATION_URL_TEMPLATE: "https://agents.example/s/{session_id}",
    }, 200, args);
    assert.equal(form, undefined);
    assert.equal(stderr, "");
    assert.match(stdout, args[0] === "--check" ? /Local configuration checks passed/ : /Usage:/);
    assert.doesNotMatch(stdout, /test-token|test-user|https:\/\/agents\.example/);
  }
});

test("bad CLI arguments fail without sending or echoing their values", async () => {
  for (const args of [
    ["--unknown=private-sentinel"], ["--message"], ["--event", "--host", "example"],
    ["--payload", "private-sentinel"], ["--payload", "[]"],
    ["private-sentinel"], ["{}", '{"private":"sentinel"}'],
  ]) {
    await assert.rejects(runScript(args, null, { PUSHOVER_DRY_RUN: "1" }), (error) => {
      assert.match(error.message, /exited 2:.*--help/);
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    });
  }
});

test("configuration checks diagnose missing credentials and invalid settings privately", async () => {
  await assert.rejects(runScript(["--check"], null, {}), /exited 1:.*PUSHOVER_API_TOKEN/);
  for (const setting of [
    { PUSHOVER_API_URL: "private-sentinel" },
    { PUSHOVER_CONVERSATION_URL: "https://private-sentinel@agents.example/" },
    { PUSHOVER_CONVERSATION_URL_TEMPLATE: "https://agents.example/{private-sentinel}" },
    { PUSHOVER_PRIORITY: "private-sentinel" },
    { PUSHOVER_PRIORITY: "2" },
  ]) {
    await assert.rejects(runScript(["--check"], null, {
      PUSHOVER_API_TOKEN: "test-token", PUSHOVER_USER_KEY: "test-user", ...setting,
    }), (error) => {
      assert.match(error.message, /exited 1:/);
      assert.doesNotMatch(error.message, /private-sentinel|test-token|test-user/);
      return true;
    });
  }
});

test("invalid conversation links are omitted while the alert is still delivered", async () => {
  for (const url of [
    "https://agents.example/" + "a".repeat(512),
    "private-sentinel",
    "javascript:private-sentinel",
    "https://private-sentinel@agents.example/",
  ]) {
    const { form, stderr } = await capture({ event: "input", message: "Select a target.", conversation_url: url });
    assert.equal(form.get("url"), null);
    assert.equal(form.get("url_title"), null);
    assert.equal(form.get("message"), "Select a target.");
    assert.match(stderr, /Conversation link omitted/);
    assert.doesNotMatch(stderr, /private-sentinel/);
  }
  for (const template of ["https://agents.example/{session_id}", "https://agents.example/{unknown}"]) {
    const { form, stderr } = await capture({ event: "input", host: "my-agent" }, {
      PUSHOVER_CONVERSATION_URL_TEMPLATE: template,
    });
    assert.equal(form.get("url"), null);
    assert.match(stderr, /Conversation link omitted/);
  }
});

test("a conversation URL at the size limit is preserved exactly", async () => {
  const prefix = "https://agents.example/";
  const url = prefix + "a".repeat(512 - prefix.length);
  const { form } = await capture({ event: "completed", message: "Long result. ".repeat(120), conversation_url: url });
  assert.equal(form.get("url"), url);
  assert.ok(form.get("message").endsWith(url));
  assert.ok(form.get("message").length <= 1024);
});
