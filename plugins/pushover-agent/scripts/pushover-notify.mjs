#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";

const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;
const MAX_URL = 512;

function first(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const [rawKey, inlineValue] = item.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replaceAll("-", "_");
    result[key] = inlineValue ?? argv[++index] ?? "";
  }
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
    if (candidate?.role === "assistant" || (candidate?.type === "message" && candidate?.role === "assistant")) {
      const text = contentText(candidate.content);
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
  if (payload.type === "agent-turn-complete" || payload["thread-id"] || payload.thread_id || payload.turn_id || process.env.CODEX_THREAD_ID) return "Codex";
  if (payload.notification_type || payload.session_id || process.env.CLAUDE_PLUGIN_ROOT) return "Claude Code";
  return "Agent";
}

function detectEvent(payload, args) {
  return first(args.event, payload.hook_event_name, payload.hookEventName, payload.event, payload.type, process.env.AGENT_EVENT, "completed");
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
  if (normalized === "input") return "input";
  if (normalized.includes("permission") || notification.includes("permission")) return "input";
  if (normalized === "notification" || notification.includes("idle")) return "input";
  if (normalized.includes("sessionend") || normalized === "stopped" || normalized === "interrupt") return "stopped";
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
  return template.replace(/\{(session_id|thread_id|turn_id|host)\}/g, (_match, key) => encodeURIComponent(values[key] || ""));
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
  if (explicit) return truncate(explicit, MAX_URL);

  const template = first(process.env.PUSHOVER_CONVERSATION_URL_TEMPLATE, process.env.AGENT_CONVERSATION_URL_TEMPLATE);
  if (template) return truncate(applyTemplate(template, { ...ids, host }), MAX_URL);

  const codexId = host === "Codex" ? ids.thread_id || ids.session_id : "";
  return codexId ? `codex://threads/${encodeURIComponent(codexId)}` : "";
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
  const cwd = first(payload.cwd, process.env.AGENT_CWD, process.cwd());
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
  const url = conversationUrl(payload, args, host);
  const fallback = state === "input" ? "The agent is waiting for you." : state === "stopped" ? "The agent stopped." : "The agent completed its turn.";
  const excerpt = truncate(message || fallback, url ? 780 : MAX_MESSAGE);
  const body = truncate(url ? `${excerpt}\n\nOpen conversation: ${url}` : excerpt, MAX_MESSAGE);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = { ...(await readInput()), ...(args.payload ? JSON.parse(args.payload) : {}) };
  const notice = notification(payload, args);
  if (notice.event.toLowerCase().includes("subagent") && !isTruthy(process.env.PUSHOVER_NOTIFY_SUBAGENTS)) return;

  if (isTruthy(process.env.PUSHOVER_DRY_RUN)) {
    process.stdout.write(`${JSON.stringify(notice)}\n`);
    return;
  }

  const token = first(process.env.PUSHOVER_API_TOKEN, process.env.PUSHOVER_TOKEN);
  const user = first(process.env.PUSHOVER_USER_KEY, process.env.PUSHOVER_USER);
  if (!token || !user) throw new Error("Set PUSHOVER_API_TOKEN (or PUSHOVER_TOKEN) and PUSHOVER_USER_KEY (or PUSHOVER_USER)");

  const fields = { token, user, title: notice.title, message: notice.message };
  if (notice.url) {
    fields.url = notice.url;
    fields.url_title = "Open conversation";
  }
  for (const [field, envName] of [["device", "PUSHOVER_DEVICE"], ["sound", "PUSHOVER_SOUND"], ["priority", "PUSHOVER_PRIORITY"]]) {
    if (first(process.env[envName])) fields[field] = first(process.env[envName]);
  }
  await requestPushover(first(process.env.PUSHOVER_API_URL, "https://api.pushover.net/1/messages.json"), fields);
}

main().catch((error) => {
  process.stderr.write(`[pushover-agent] ${error.message}\n`);
  process.exitCode = isTruthy(process.env.PUSHOVER_FAIL_HARD) ? 1 : 0;
});
