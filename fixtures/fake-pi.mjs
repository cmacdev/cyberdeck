#!/usr/bin/env node

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
};
const prompt = args.at(-1) ?? "";
const model = valueAfter("--model") ?? "unknown";

if (prompt.includes("FAKE_WAIT")) {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

process.stdout.write(
  `${JSON.stringify({
    type: "session",
    version: 3,
    id: "fake-session",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  })}\n`,
);

const payload = {
  argv: args,
  cwd: process.cwd(),
  piStateDirectory: process.env.PI_CODING_AGENT_DIR ?? null,
  versionCheck: process.env.PI_SKIP_VERSION_CHECK ?? null,
  telemetry: process.env.PI_TELEMETRY ?? null,
};
const failing = prompt.includes("FAKE_FAIL");
process.stdout.write(
  `${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(payload) }],
      model,
      stopReason: failing ? "error" : "stop",
      ...(failing ? { errorMessage: "Deliberate fake failure." } : {}),
      usage: {
        input: 12,
        output: 34,
        cacheRead: 5,
        cacheWrite: 6,
        cost: { total: 0.007 },
        totalTokens: 57,
      },
    },
  })}\n`,
);

if (failing) {
  process.stderr.write("fake pi failed\n");
  process.exitCode = 7;
}
