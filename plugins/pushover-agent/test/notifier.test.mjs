import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
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

async function capture(payload, extraEnv = {}, statusCode = 200, args = []) {
  let received;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = new URLSearchParams(body);
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
    const result = await runScript(args, payload === null ? null : JSON.stringify(payload), {
      PUSHOVER_API_TOKEN: "test-token",
      PUSHOVER_USER_KEY: "test-user",
      PUSHOVER_API_URL: `http://127.0.0.1:${port}/1/messages.json`,
      ...extraEnv,
    });
    return { form: received, ...result };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test("sends a final Codex notification with its thread deep link", async () => {
  const { form } = await capture({
    hook_event_name: "Stop",
    thread_id: "thread-123",
    cwd: "/work/my-project",
    last_assistant_message: "Implemented and verified the change.",
  });
  assert.match(form.get("title"), /Codex finished/);
  assert.equal(form.get("url"), "codex://threads/thread-123");
  assert.match(form.get("message"), /Implemented and verified/);
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
  const claude = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
  for (const [host, hooksPath, events] of [
    ["Codex", "hooks.json", ["Stop", "PermissionRequest"]],
    ["Claude Code", claude.hooks, ["Stop", "Notification", "PermissionRequest"]],
  ]) {
    const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, hooksPath), "utf8"));
    for (const event of events) {
      const hooks = config.hooks[event].flatMap((group) => group.hooks);
      assert.ok(hooks.length, `${host} ${event} must have a hook`);
      for (const hook of hooks) {
        const { stdout } = await runScript([], JSON.stringify({
          hook_event_name: event,
          session_id: "session-123",
          last_assistant_message: event === "Stop" ? "Which deployment should I use?" : "Review this network request.",
        }), {
          PUSHOVER_DRY_RUN: "1",
          PLUGIN_ROOT: pluginRoot,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
        }, hook.command);
        const notice = JSON.parse(stdout);
        assert.equal(notice.host, host, `${host} ${event} host`);
        assert.equal(notice.state, "input", `${host} ${event} state`);
        assert.equal(notice.url, host === "Codex" ? "codex://threads/session-123" : "");
      }
    }
  }
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
