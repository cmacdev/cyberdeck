#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};
const model = valueAfter("--model") ?? "unknown";
process.stdin.setEncoding("utf8");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const has = (keyword) => prompt.includes(keyword);

if (process.env.FAKE_PI_PIDFILE) writeFileSync(process.env.FAKE_PI_PIDFILE, String(process.pid));

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const messageEnd = (content, extra = {}) =>
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content,
      model,
      stopReason: "stop",
      usage: {
        input: 12,
        output: 34,
        cacheRead: 5,
        cacheWrite: 6,
        cost: { total: 0.007 },
        totalTokens: 57,
      },
      ...extra,
    },
  });

if (has("FAKE_STDERR_ONLY")) {
  process.stderr.write("fake pi crashed before emitting JSON\n");
  process.exitCode = 3;
} else {
  emit({
    type: "session",
    version: 3,
    id: "fake-session",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });

  if (has("FAKE_HANG") || has("FAKE_IGNORE_TERM")) {
    if (has("FAKE_IGNORE_TERM")) process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (has("FAKE_FLOOD")) {
    for (let index = 0; index < 2000; index += 1) {
      emit({ type: "message_update", index, pad: "x".repeat(200) });
    }
    messageEnd([{ type: "text", text: "flooded" }]);
  } else if (has("FAKE_SILENT")) {
    messageEnd([]);
  } else if (has("FAKE_LINGER")) {
    messageEnd([{ type: "text", text: "lingered" }]);
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], {
      detached: true,
      stdio: ["ignore", "inherit", "ignore"],
    }).unref();
  } else {
    if (has("FAKE_WAIT")) await new Promise((resolve) => setTimeout(resolve, 150));
    const payload = {
      argv: args,
      prompt,
      cwd: process.cwd(),
      piStateDirectory: process.env.PI_CODING_AGENT_DIR ?? null,
      versionCheck: process.env.PI_SKIP_VERSION_CHECK ?? null,
      telemetry: process.env.PI_TELEMETRY ?? null,
    };
    const failing = has("FAKE_FAIL");
    messageEnd(
      [{ type: "text", text: JSON.stringify(payload) }],
      failing ? { stopReason: "error", errorMessage: "Deliberate fake failure." } : {},
    );
    if (failing) {
      process.stderr.write("fake pi failed\n");
      process.exitCode = 7;
    }
  }
}
