#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";

const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;
const MAX_URL = 512;
const DEFAULT_API_URL = "https://api.pushover.net/1/messages.json";

function first(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function parseObject(value, invalid) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Reported below without echoing the value.
  }
  throw invalid;
}

function parseArgs(argv) {
  const result = {};
  const invalid = Object.assign(new Error("Invalid command-line arguments. Use --help for usage."), { exitCode: 2 });
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") { result.help = true; continue; }
    if (item === "--check") { result.check = true; continue; }
    if (!item.startsWith("--")) {
      // Codex's legacy `notify` setting passes the event as a single JSON argument instead of stdin.
      if (result.notify) throw invalid;
      result.notify = parseObject(item, invalid);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    if (!["event", "host", "message", "url", "payload"].includes(rawKey)) throw invalid;
    const value = inlineValue ?? argv[++index];
    if (value === undefined || (inlineValue === undefined && (value.startsWith("--") || value === "-h"))) throw invalid;
    result[rawKey] = value;
  }
  if (result.payload !== undefined) result.payload = parseObject(result.payload, invalid);
  return result;
}

async function readInput() {
  if (process.stdin.isTTY) return {};
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { message: value.trim() };
  }
}

function truncate(value, limit) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : first(part?.text, part?.content, part?.output_text)))
    .filter(Boolean)
    .join("\n");
}

function assistantTextFromRecord(record) {
  const candidates = [record, record?.payload, record?.message, record?.payload?.message].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate?.role === "assistant") {
      // Cursor keeps the role on the record and the content under `message`.
      const text = contentText(candidate.content ?? candidate.message?.content);
      if (text) return text;
    }
  }
  return "";
}

function lastTranscriptMessage(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - 1024 * 1024);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(transcriptPath, "r");
    fs.readSync(descriptor, buffer, 0, length, start);
    fs.closeSync(descriptor);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const text = assistantTextFromRecord(JSON.parse(lines[index]));
        if (text) return text;
      } catch {
        // A partial first line or unrelated transcript record is expected.
      }
    }
  } catch {
    // Notifications should never break an agent because a transcript is unavailable.
  }
  return "";
}

function detectHost(payload, args) {
  const namedHost = first(args.host, payload.host, process.env.AGENT_HOST);
  if (namedHost) return namedHost;
  if (payload.type === "agent-turn-complete" || payload["thread-id"] || payload.thread_id || payload.turn_id) return "Codex";
  // Cursor hooks also carry session_id and CLAUDE_PLUGIN_ROOT, so recognize Cursor before Claude Code.
  if (payload.cursor_version) return "Cursor";
  if (process.env.CODEX_THREAD_ID) return "Codex";
  if (process.env.CURSOR_VERSION) return "Cursor";
  if (payload.notification_type || payload.session_id || process.env.CLAUDE_PLUGIN_ROOT) return "Claude Code";
  return "Agent";
}

function detectEvent(payload, args) {
  return first(args.event, payload.event, payload.hook_event_name, payload.hookEventName, payload.type, process.env.AGENT_EVENT, "Stop");
}

function looksLikeQuestion(text) {
  const tail = String(text || "").trim().slice(-800);
  if (!tail) return false;
  return /\?\s*(?:[*_`.)\]]*)$/u.test(tail)
    || /(?:please (?:choose|confirm|provide|tell me)|could you|would you|do you want|should I|which (?:option|one)|what would you|need (?:your|you to)|waiting for your)/iu.test(tail);
}

function classify(event, payload, message) {
  const normalized = event.toLowerCase();
  const notification = String(payload.notification_type || "").toLowerCase();
  if (normalized === "completed" || normalized === "complete") return "complete";
  if (normalized === "input" || normalized === "stopped") return normalized;
  if (normalized.includes("permission") || notification.includes("permission")) return "input";
  if (normalized === "notification" || notification.includes("idle")) return "input";
  if (normalized.includes("sessionend") || normalized === "interrupt") return "stopped";
  // Cursor reports cancelled and failed turns through the stop hook's status.
  if (["aborted", "error"].includes(String(payload.status || "").toLowerCase())) return "stopped";
  if (looksLikeQuestion(message)) return "input";
  return "complete";
}

function identifiers(payload) {
  return {
    session_id: first(payload.session_id, payload.sessionId, process.env.AGENT_SESSION_ID),
    thread_id: first(payload.thread_id, payload.threadId, payload["thread-id"], process.env.CODEX_THREAD_ID),
    turn_id: first(payload.turn_id, payload.turnId, payload["turn-id"]),
  };
}

function applyTemplate(template, values) {
  return template.replace(/\{([^{}]+)\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) throw new Error("Conversation URL template has an unsupported placeholder.");
    if (!values[key]) throw new Error(`Conversation URL template requires ${key}.`);
    return encodeURIComponent(values[key]);
  });
}

function validateConversationUrl(value) {
  if (!value) return "";
  if (value.length > MAX_URL) throw new Error("Conversation URL exceeds 512 characters.");
  try {
    const url = new URL(value);
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value) || !url.hostname
      || ["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol)
      || url.username || url.password || /[\s{}\\]/u.test(value)) throw new Error();
  } catch {
    throw new Error("Conversation URL must be an absolute web or app link without credentials, whitespace, or placeholders.");
  }
  return value;
}

function conversationUrl(payload, args, host) {
  const ids = identifiers(payload);
  const explicit = first(
    args.url,
    payload.conversation_url,
    payload.conversationUrl,
    payload.share_url,
    payload.shareUrl,
    payload.web_url,
    process.env.PUSHOVER_CONVERSATION_URL,
    process.env.AGENT_CONVERSATION_URL,
  );
  if (explicit) return validateConversationUrl(explicit);

  const template = first(process.env.PUSHOVER_CONVERSATION_URL_TEMPLATE, process.env.AGENT_CONVERSATION_URL_TEMPLATE);
  if (template) return validateConversationUrl(applyTemplate(template, { ...ids, host }));

  const codexId = host === "Codex" ? ids.thread_id || ids.session_id : "";
  return validateConversationUrl(codexId ? `codex://threads/${encodeURIComponent(codexId)}` : "");
}

function messageFromPayload(payload, args) {
  return first(
    args.message,
    payload.last_assistant_message,
    payload["last-assistant-message"],
    payload.agent_message,
    payload.message,
    payload.result,
    lastTranscriptMessage(first(payload.transcript_path, payload.transcriptPath)),
  );
}

function projectName(payload) {
  const workspaceRoot = Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : "";
  const cwd = first(payload.cwd, workspaceRoot, process.env.AGENT_CWD, process.cwd());
  return path.basename(cwd) || "task";
}

function notification(payload, args) {
  const host = detectHost(payload, args);
  const event = detectEvent(payload, args);
  const message = messageFromPayload(payload, args);
  const state = classify(event, payload, message);
  const project = projectName(payload);
  const prefix = first(process.env.PUSHOVER_TITLE_PREFIX);
  const label = state === "input" ? "needs input" : state === "stopped" ? "stopped" : "finished";
  const title = truncate([prefix, `${host} ${label}`, `— ${project}`].filter(Boolean).join(" "), MAX_TITLE);
  let url = "";
  try {
    url = conversationUrl(payload, args, host);
  } catch (error) {
    process.stderr.write(`[pushover-agent] Conversation link omitted: ${error.message}\n`);
  }
  const fallback = state === "input" ? "The agent is waiting for you." : state === "stopped" ? "The agent stopped." : "The agent completed its turn.";
  const suffix = url ? `\n\nOpen conversation: ${url}` : "";
  const body = truncate(message || fallback, MAX_MESSAGE - suffix.length) + suffix;
  return { title, message: body, url, state, host, event };
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function requestPushover(endpoint, fields) {
  return new Promise((resolve, reject) => {
    const target = new URL(endpoint);
    const body = new URLSearchParams(fields).toString();
    const transport = target.protocol === "http:" ? http : https;
    const request = transport.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
      timeout: 10_000,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300) resolve(responseBody);
        else reject(new Error(`Pushover returned HTTP ${response.statusCode || "unknown"}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("Pushover request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function hostTokenName(host) {
  if (host === "Claude Code") return "PUSHOVER_API_TOKEN_CC";
  return `PUSHOVER_API_TOKEN_${host.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function credentials(host) {
  // A per-host application token (PUSHOVER_API_TOKEN_CODEX, _CURSOR, _CC, ...) wins over the shared one.
  const token = first(process.env[hostTokenName(host)], process.env.PUSHOVER_API_TOKEN, process.env.PUSHOVER_TOKEN);
  const user = first(process.env.PUSHOVER_USER_KEY, process.env.PUSHOVER_USER);
  if (!token || !user) {
    throw new Error(`Set PUSHOVER_API_TOKEN (or ${hostTokenName(host)}) and PUSHOVER_USER_KEY (or PUSHOVER_USER)`);
  }
  return { token, user };
}

function checkConfiguration(args) {
  const payload = { ...args.notify, ...args.payload };
  const host = detectHost(payload, args);
  credentials(host);
  try {
    const endpoint = new URL(first(process.env.PUSHOVER_API_URL, DEFAULT_API_URL));
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error();
  } catch {
    throw new Error("PUSHOVER_API_URL must be an HTTP(S) URL without embedded credentials.");
  }
  const priority = first(process.env.PUSHOVER_PRIORITY);
  if (priority && !["-2", "-1", "0", "1"].includes(priority)) {
    throw new Error("PUSHOVER_PRIORITY must be -2, -1, 0, or 1; emergency priority is not supported.");
  }
  // Check template syntax with sample IDs; real identifiers are validated when the hook runs.
  conversationUrl({ session_id: "check", thread_id: "check", turn_id: "check", ...payload }, args, host);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: node plugins/pushover-agent/scripts/pushover-notify.mjs [options]

  --help, -h          Show this help without reading stdin or sending a notification.
  --check            Check local configuration without reading stdin or making network requests.
  --event VALUE      completed, input, stopped, or a host lifecycle event (otherwise inferred).
  --host VALUE       Agent name.
  --message VALUE    Notification text.
  --url VALUE        Absolute conversation URL, up to 512 characters.
  --payload JSON     JSON object overriding stdin fields; metadata for templates and hooks.
  JSON               A single JSON object argument (Codex \`notify\`) replaces stdin.

Normal mode reads lifecycle JSON or plain text from stdin.
Credentials: PUSHOVER_API_TOKEN and PUSHOVER_USER_KEY (aliases PUSHOVER_TOKEN and PUSHOVER_USER).
PUSHOVER_API_TOKEN_<HOST> (for example _CODEX, _CURSOR; _CC for Claude Code) overrides the token per host.
PUSHOVER_DRY_RUN=1 previews an alert; PUSHOVER_FAIL_HARD=1 makes delivery failures exit 1.
CLI errors exit 2; failed --check exits 1. See README.md for all settings.
`);
    return;
  }
  if (args.check) {
    try {
      checkConfiguration(args);
    } catch (error) {
      throw Object.assign(error, { exitCode: 1 });
    }
    process.stdout.write("Local configuration checks passed: credential presence, API endpoint, priority, and link syntax.\nNo network request was made; credential validity, runtime identifiers, and mobile delivery are unverified.\n");
    return;
  }
  const payload = { ...(args.notify ?? await readInput()), ...args.payload };
  const notice = notification(payload, args);
  if (notice.event.toLowerCase().includes("subagent") && !isTruthy(process.env.PUSHOVER_NOTIFY_SUBAGENTS)) return;

  if (isTruthy(process.env.PUSHOVER_DRY_RUN)) {
    process.stdout.write(`${JSON.stringify(notice)}\n`);
    return;
  }

  const { token, user } = credentials(notice.host);

  const fields = { token, user, title: notice.title, message: notice.message };
  if (notice.url) {
    fields.url = notice.url;
    fields.url_title = "Open conversation";
  }
  for (const [field, envName] of [["device", "PUSHOVER_DEVICE"], ["sound", "PUSHOVER_SOUND"], ["priority", "PUSHOVER_PRIORITY"]]) {
    if (first(process.env[envName])) fields[field] = first(process.env[envName]);
  }
  await requestPushover(first(process.env.PUSHOVER_API_URL, DEFAULT_API_URL), fields);
}

main().catch((error) => {
  process.stderr.write(`[pushover-agent] ${error.message}\n`);
  process.exitCode = error.exitCode ?? (isTruthy(process.env.PUSHOVER_FAIL_HARD) ? 1 : 0);
});
