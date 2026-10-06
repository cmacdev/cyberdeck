import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { makeFixture, packageDirectory } from "./helpers.mjs";
import { inferenceKey } from "../fixtures/venice-api.mjs";

const realExecFile = promisify(execFile);
const testSystemPath = [
  path.dirname(process.execPath),
  "/run/current-system/sw/bin",
  "/usr/bin",
  "/bin",
].join(":");

async function withNpmStub(options = {}) {
  const env = { ...(options.env ?? {}) };
  const stub = await mkdtemp(path.join(tmpdir(), "cyberdeck-npm-"));
  const prefix = path.join(stub, "prefix");
  const prefixBin = path.join(prefix, "bin");
  await mkdir(prefixBin, { recursive: true });
  await mkdir(path.join(stub, "root"), { recursive: true });
  const trace = env.CYBERDECK_NPM_TRACE || path.join(stub, "npm-calls");
  await writeFile(
    path.join(stub, "npm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(trace)}\ncase "$1" in\n  root) printf '%s\\n' ${JSON.stringify(path.join(stub, "root"))} ;;\n  prefix) printf '%s\\n' ${JSON.stringify(prefix)} ;;\nesac\nexit 0\n`,
  );
  await chmod(path.join(stub, "npm"), 0o755);
  return { ...options, env: { ...env, PATH: `${stub}:${prefixBin}:${env.PATH ?? ""}` } };
}

function execFileAsync(command, args, options) {
  return (async () => {
    if (command === "bash" && args?.[0] === "install.sh") options = await withNpmStub(options);
    return realExecFile(command, args, options);
  })();
}

function runWithClosedInput(command, args, options) {
  return new Promise((resolve, reject) => {
    const start = async () => {
      if (command === "bash" && args?.[0] === "install.sh") options = await withNpmStub(options);
      const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    };
    start().catch(reject);
  });
}

test("codex-only install and uninstall never invoke or restore Claude integrations", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  const invoked = path.join(fixture.root, "claude-invoked");
  for (const [name, script] of [
    ["pi", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.84.2"; else echo ready; fi\n'],
    ["uname", "#!/bin/sh\necho Darwin\n"],
    ["claude", `#!/bin/sh\ntouch '${invoked}'\nexit 1\n`],
    ["open", `#!/bin/sh\nif [ "$2" = "Claude" ]; then touch '${invoked}'; fi\nexit 1\n`],
  ]) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  const env = { ...process.env, HOME: fixture.root, CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"), PI_CODING_AGENT_DIR: path.join(fixture.root, ".pi/agent"), PATH: `${bin}:${testSystemPath}` };
  await execFileAsync("bash", ["install.sh", "--codex-only", "--provider", "openrouter"], { cwd: packageDirectory, env });
  assert.equal(existsSync(path.join(fixture.root, ".claude.json")), false);
  assert.equal(existsSync(path.join(fixture.root, ".claude", "settings.json")), false);
  assert.equal(existsSync(path.join(fixture.root, ".claude/skills/deck")), false);
  assert.ok(existsSync(path.join(fixture.root, ".codex/skills/deck/SKILL.md")));
  await writeFile(path.join(fixture.root, ".claude.json"), JSON.stringify({ mcpServers: { cyberdeck: {}, other: {} } }));
  await execFileAsync("bash", ["install.sh", "--codex-only", "--uninstall"], { cwd: packageDirectory, env });
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, ".claude.json"), "utf8")).mcpServers, { other: {} });
  assert.equal(existsSync(invoked), false);
});

test("Venice install replaces a stale policy and preserves provider credentials", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.84.2"; else echo ready; fi\n'],
    ["uname", "#!/bin/sh\necho Linux\n"],
  ]) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  const preload = path.join(fixture.root, "fetch.mjs");
  await writeFile(preload, `import { veniceFixture } from ${JSON.stringify(path.join(packageDirectory, "fixtures/venice-api.mjs"))}; globalThis.fetch = veniceFixture().fetch;\n`);
  const cyberdeckHome = path.join(fixture.root, ".cyberdeck");
  const agentDirectory = path.join(fixture.root, "custom-pi-state");
  const env = {
    ...process.env, HOME: fixture.root, CYBERDECK_HOME: cyberdeckHome,
    PI_CODING_AGENT_DIR: agentDirectory, VENICE_API_KEY: inferenceKey,
    PATH: `${bin}:${testSystemPath}`, NODE_OPTIONS: `--import=${preload}`,
  };
  const dry = await execFileAsync("bash", ["install.sh", "--provider", "venice", "--dry-run"], { cwd: packageDirectory, env });
  assert.match(dry.stdout, /blocks anonymous/);
  assert.equal(existsSync(agentDirectory), false);
  await writeFile(preload, `import { veniceFixture } from ${JSON.stringify(path.join(packageDirectory, "fixtures/venice-api.mjs"))}; globalThis.fetch = veniceFixture({ failPath: "/chat/completions" }).fetch;\n`);
  const failed = await runWithClosedInput("bash", ["install.sh", "--provider", "venice"], { cwd: packageDirectory, env });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Venice setup failed/);
  assert.equal(existsSync(path.join(agentDirectory, "auth.json")), false);
  assert.equal(existsSync(path.join(cyberdeckHome, "cyberdeck.config.json")), false);
  await writeFile(preload, `import { veniceFixture } from ${JSON.stringify(path.join(packageDirectory, "fixtures/venice-api.mjs"))}; globalThis.fetch = veniceFixture().fetch;\n`);
  const installed = await execFileAsync("bash", ["install.sh", "--provider", "venice"], { cwd: packageDirectory, env });
  assert.match(installed.stdout, /verified: resolved config loads/);
  assert.ok(!installed.stdout.includes(inferenceKey));
  assert.ok(!installed.stderr.includes(inferenceKey));
  const configPath = path.join(cyberdeckHome, "cyberdeck.config.json");
  const shipped = JSON.parse(await readFile(path.join(packageDirectory, "cyberdeck.config.json"), "utf8"));
  const policy = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(policy.provider, "venice");
  assert.equal(policy.pi.stateDirectory, agentDirectory);
  assert.equal(policy.pi.command, path.join(bin, "pi"));
  assert.equal(policy.artifactDirectory, path.join(cyberdeckHome, "runs"));
  policy.limits.maxTaskCharacters = 1234;
  policy.models["kimi-k3"].providers.venice.id = "z-ai-glm-5-2";
  await writeFile(configPath, JSON.stringify(policy));
  const schemaPath = path.join(cyberdeckHome, "cyberdeck.config.schema.json");
  await writeFile(schemaPath, "{\"custom\":true}\n");
  const authPath = path.join(agentDirectory, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  assert.deepEqual(auth.venice, { type: "api_key", key: inferenceKey });
  await writeFile(preload, `import { veniceFixture } from ${JSON.stringify(path.join(packageDirectory, "fixtures/venice-api.mjs"))}; globalThis.fetch = veniceFixture({ failPath: "/chat/completions" }).fetch;\n`);
  const failedAgain = await runWithClosedInput("bash", ["install.sh", "--provider", "venice"], { cwd: packageDirectory, env });
  assert.equal(failedAgain.code, 1);
  assert.equal(await readFile(configPath, "utf8"), JSON.stringify(policy));
  assert.equal(await readFile(schemaPath, "utf8"), "{\"custom\":true}\n");
  await writeFile(preload, `import { veniceFixture } from ${JSON.stringify(path.join(packageDirectory, "fixtures/venice-api.mjs"))}; globalThis.fetch = veniceFixture().fetch;\n`);
  const repeated = await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.match(repeated.stdout, /provider: Venice/);
  assert.match(repeated.stdout, /replaced installed policy/);
  const replaced = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(replaced.limits.maxTaskCharacters, shipped.limits.maxTaskCharacters);
  assert.deepEqual(replaced.models, shipped.models);
  assert.equal(replaced.provider, "venice");
  assert.equal(replaced.pi.stateDirectory, agentDirectory);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await execFileAsync("bash", ["install.sh", "--provider", "openrouter"], { cwd: packageDirectory, env });
  const switched = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(switched.provider, "openrouter");
  assert.deepEqual(switched.models, shipped.models);
  assert.deepEqual(switched.profiles, shipped.profiles);
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), auth);
  await execFileAsync("bash", ["install.sh", "--provider", "venice"], { cwd: packageDirectory, env });
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).provider, "venice");
  const models = JSON.parse(await readFile(path.join(agentDirectory, "models.json"), "utf8"));
  assert.equal(models.providers.openrouter.compat.openRouterRouting.zdr, true);
  assert.equal(models.providers.venice.models.length, Object.values(shipped.models).filter((model) => model.providers.venice).length);
});

test("OpenRouter model and payload overrides cannot weaken the installer ZDR pin", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.84.2"; else echo ready; fi\n'],
    ["uname", "#!/bin/sh\necho Linux\n"],
  ]) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  const agentDirectory = path.join(fixture.root, ".pi/agent");
  await mkdir(agentDirectory, { recursive: true });
  const file = path.join(agentDirectory, "models.json");
  await writeFile(file, JSON.stringify({ providers: { openrouter: {
    compat: { openRouterRouting: { zdr: true, data_collection: "deny" } },
    modelOverrides: { example: { compat: { openRouterRouting: { zdr: false, order: ["keep"] } } } },
    models: [{ id: "custom", samplingParams: { provider: null } }],
  } } }));
  await execFileAsync("bash", ["install.sh", "--provider", "openrouter"], {
    cwd: packageDirectory,
    env: { ...process.env, HOME: fixture.root, CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"), PI_CODING_AGENT_DIR: agentDirectory, PATH: `${bin}:${testSystemPath}` },
  });
  const provider = JSON.parse(await readFile(file, "utf8")).providers.openrouter;
  assert.deepEqual(provider.modelOverrides.example.compat.openRouterRouting, { zdr: true, order: ["keep"], data_collection: "deny" });
  assert.deepEqual(provider.models[0].samplingParams.provider, { zdr: true, data_collection: "deny" });
});

test("the Linux dry-run configures only Claude Code and the default Codex location", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Linux\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }

  const { stdout, stderr } = await execFileAsync("bash", ["install.sh", "--dry-run"], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      HOME: fixture.root,
      CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"),
      PATH: `${bin}:${testSystemPath}`,
    },
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Claude Code CLI not found; would register cyberdeck directly in .*\.claude\.json/);
  assert.match(stdout, /Codex: would append \[mcp_servers\.cyberdeck\] block to .*\.codex\/config\.toml/);
  assert.match(stdout, /Claude Code: would install the deck skill at .*\.claude\/skills\/deck/);
  assert.match(stdout, /Codex and ChatGPT Desktop: would install the deck skill at .*\.codex\/skills\/deck/);
  assert.match(stdout, /macOS desktop integrations skipped on Linux/);
  assert.doesNotMatch(stdout, /mcp__Cyberdeck/);
  assert.doesNotMatch(stdout, /OpenCode|Grok Build/);
  assert.doesNotMatch(stdout, /would run: open|would run: zip/);
});

test("the macOS dry-run uses shared Codex config and never prepares Claude Desktop", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Darwin\n"],
    ["open", "#!/bin/sh\nexit 0\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }

  const { stdout, stderr } = await execFileAsync("bash", ["install.sh", "--dry-run"], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      HOME: fixture.root,
      CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"),
      PATH: `${bin}:${testSystemPath}`,
    },
  });

  assert.equal(stderr, "");
  assert.match(stdout, /ChatGPT Desktop: uses the Codex registration/);
  assert.doesNotMatch(stdout, /Claude Desktop|mcpb|mcp__Cyberdeck/);
  assert.doesNotMatch(stdout, /desktop app detection or installation was attempted/);
});

test("a macOS install retires the Claude Desktop bundle and its deny rule", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Darwin\n"],
    ["open", "#!/bin/sh\nif [ \"$1\" = \"-Ra\" ]; then exit 0; fi\necho 'test failure: install.sh must not open a bundle' >&2\nexit 1\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  const cyberdeckHome = path.join(fixture.root, ".cyberdeck");
  const env = {
    ...process.env,
    HOME: fixture.root,
    CYBERDECK_HOME: cyberdeckHome,
    PATH: `${bin}:${testSystemPath}`,
  };
  delete env.OPENROUTER_API_KEY;
  await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  const bundle = path.join(cyberdeckHome, "cyberdeck.mcpb");
  await writeFile(bundle, "stale");
  const settingsPath = path.join(fixture.root, ".claude", "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify({
      permissions: {
        allow: ["mcp__cyberdeck__research", "Bash(ls*)"],
        ask: ["mcp__cyberdeck__implement"],
        deny: ["Bash(rm *)", "mcp__Cyberdeck"],
      },
    }, null, 2)}\n`,
  );
  const installed = await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.equal(installed.stderr, "");
  assert.match(installed.stdout, /removed the obsolete mcp__Cyberdeck deny rule/);
  assert.match(installed.stdout, /ACTION REQUIRED: remove the Cyberdeck extension in Claude Desktop/);
  assert.equal(existsSync(bundle), false);
  const permissions = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(permissions.permissions.allow, ["mcp__cyberdeck__research", "Bash(ls*)"]);
  assert.deepEqual(permissions.permissions.ask, ["mcp__cyberdeck__implement"]);
  assert.deepEqual(permissions.permissions.deny, ["Bash(rm *)"]);
  const repeated = await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.doesNotMatch(repeated.stdout, /mcp__Cyberdeck|ACTION REQUIRED/);
});

test("an install without client binaries still writes the default Claude and Codex configs", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Linux\n"],
    ["open", "#!/bin/sh\necho 'test failure: install.sh must not reach open' >&2\nexit 1\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  const cyberdeckHome = path.join(fixture.root, ".cyberdeck");
  const env = {
    ...process.env,
    HOME: fixture.root,
    CYBERDECK_HOME: cyberdeckHome,
    PATH: `${bin}:${testSystemPath}`,
  };
  delete env.OPENROUTER_API_KEY;

  const { stdout, stderr } = await execFileAsync("bash", ["install.sh"], {
    cwd: packageDirectory,
    env,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /registered cyberdeck directly in .*\.claude\.json/);
  const claude = JSON.parse(await readFile(path.join(fixture.root, ".claude.json"), "utf8"));
  assert.equal(claude.mcpServers.cyberdeck.type, "stdio");
  assert.equal(claude.mcpServers.cyberdeck.command, process.execPath);
  assert.deepEqual(claude.mcpServers.cyberdeck.args, [
    path.join(packageDirectory, "bin", "cyberdeck-mcp.mjs"),
    "--config",
    path.join(cyberdeckHome, "cyberdeck.config.json"),
  ]);
  const permissions = JSON.parse(
    await readFile(path.join(fixture.root, ".claude", "settings.json"), "utf8"),
  );
  assert.ok(permissions.permissions.allow.includes("mcp__cyberdeck__research"));
  assert.ok(permissions.permissions.ask.includes("mcp__cyberdeck__implement"));
  assert.equal(permissions.permissions.deny, undefined);
  const codex = await readFile(path.join(fixture.root, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^\[mcp_servers\.cyberdeck\]$/m);
  const models = JSON.parse(await readFile(path.join(fixture.root, ".pi", "agent", "models.json"), "utf8"));
  assert.deepEqual(models.providers.openrouter.compat.openRouterRouting, { zdr: true, data_collection: "deny" });
  const piSettingsPath = path.join(fixture.root, ".pi", "agent", "settings.json");
  assert.equal(existsSync(piSettingsPath), false);
  for (const target of [
    path.join(fixture.root, ".claude", "skills", "deck"),
    path.join(fixture.root, ".codex", "skills", "deck"),
  ]) {
    assert.match(await readFile(path.join(target, "SKILL.md"), "utf8"), /^name: deck$/m);
    assert.match(
      await readFile(path.join(target, ".cyberdeck-managed"), "utf8"),
      /managed by cyberdeck/,
    );
  }
  await execFileAsync("bash", ["install.sh", "--uninstall"], { cwd: packageDirectory, env });
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, ".pi", "agent", "models.json"), "utf8")), models);
  assert.equal(existsSync(piSettingsPath), false);
});

test("the uninstall reverses the install and preserves unrelated configuration", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Linux\n"],
    ["open", "#!/bin/sh\necho 'test failure: install.sh must not reach open' >&2\nexit 1\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  const env = {
    ...process.env,
    HOME: fixture.root,
    CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"),
    PATH: `${bin}:${testSystemPath}`,
  };
  delete env.OPENROUTER_API_KEY;
  await mkdir(path.join(fixture.root, ".codex"), { recursive: true });
  await writeFile(path.join(fixture.root, ".codex", "config.toml"), 'model = "keep-me"\n');
  await mkdir(path.join(fixture.root, ".claude"), { recursive: true });
  await writeFile(
    path.join(fixture.root, ".claude", "settings.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash(ls*)"], deny: ["Bash(rm *)", "mcp__Cyberdeck"] } }, null, 2)}\n`,
  );
  const modelsPath = path.join(fixture.root, ".pi", "agent", "models.json");
  await mkdir(path.dirname(modelsPath), { recursive: true });
  const userRouting = { providers: { openrouter: { compat: { openRouterRouting: { order: ["xai"], zdr: true, data_collection: "deny" } } } } };
  await writeFile(modelsPath, `${JSON.stringify(userRouting, null, 2)}\n`);
  const piSettingsPath = path.join(fixture.root, ".pi", "agent", "settings.json");
  const userSettings = { theme: "dark" };
  await writeFile(piSettingsPath, `${JSON.stringify(userSettings, null, 2)}\n`);

  await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  const installedModels = JSON.parse(await readFile(modelsPath, "utf8"));
  assert.deepEqual(installedModels.providers.openrouter.compat, userRouting.providers.openrouter.compat);
  assert.deepEqual(JSON.parse(await readFile(piSettingsPath, "utf8")), userSettings, "install preserves settings without a default model");
  const legacySettings = {
    ...userSettings,
    cyberdeckDefaults: true,
    defaultProvider: "openrouter",
    defaultModel: "user-choice",
    defaultThinkingLevel: "low",
    enableInstallTelemetry: false,
  };
  await writeFile(piSettingsPath, `${JSON.stringify(legacySettings, null, 2)}\n`);
  const { stdout, stderr } = await execFileAsync("bash", ["install.sh", "--uninstall"], {
    cwd: packageDirectory,
    env,
  });

  assert.equal(stderr, "");
  assert.match(stdout, /removed cyberdeck from .*\.claude\.json/);
  const claude = JSON.parse(await readFile(path.join(fixture.root, ".claude.json"), "utf8"));
  assert.equal(claude.mcpServers?.cyberdeck, undefined);
  const permissions = JSON.parse(
    await readFile(path.join(fixture.root, ".claude", "settings.json"), "utf8"),
  );
  assert.deepEqual(permissions.permissions.allow, ["Bash(ls*)"]);
  assert.deepEqual(permissions.permissions.ask, []);
  assert.deepEqual(permissions.permissions.deny, ["Bash(rm *)"]);
  const codex = await readFile(path.join(fixture.root, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "keep-me"$/m);
  assert.doesNotMatch(codex, /cyberdeck/);
  assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), installedModels, "uninstall leaves provider settings");
  assert.deepEqual(JSON.parse(await readFile(piSettingsPath, "utf8")), legacySettings, "uninstall preserves settings marked by an older installer");
  for (const target of [".claude/skills/deck", ".codex/skills/deck", ".cyberdeck"]) {
    assert.equal(existsSync(path.join(fixture.root, target)), false, `${target} should be gone`);
  }
});

test("a reinstall replaces an unavailable configured Pi with the detected executable", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  const cyberdeckHome = path.join(fixture.root, ".cyberdeck");
  await mkdir(bin);
  await mkdir(cyberdeckHome);
  for (const [name, script] of [
    ["pi", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.84.2"; else echo ready; fi\n'],
    ["uname", "#!/bin/sh\necho Linux\n"],
  ]) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  const config = JSON.parse(await readFile(path.join(packageDirectory, "cyberdeck.config.json"), "utf8"));
  config.pi.command = path.join(fixture.root, "missing-pi");
  const configPath = path.join(cyberdeckHome, "cyberdeck.config.json");
  await writeFile(configPath, JSON.stringify(config));
  const env = { ...process.env, HOME: fixture.root, CYBERDECK_HOME: cyberdeckHome, PATH: `${bin}:${testSystemPath}` };
  delete env.OPENROUTER_API_KEY;
  const { stdout } = await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.match(stdout, /replaced installed policy/);
  assert.match(stdout, /verified: resolved config loads/);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).pi.command, path.join(bin, "pi"));
});

test("the uninstall is safe on a clean home and never touches an unmanaged deck skill", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  const fakeUname = path.join(bin, "uname");
  await writeFile(fakeUname, "#!/bin/sh\necho Linux\n");
  await chmod(fakeUname, 0o755);
  const existing = path.join(fixture.root, ".claude", "skills", "deck");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "SKILL.md"), "user-owned\n");

  const { code, stdout, stderr } = await runWithClosedInput(
    "bash",
    ["install.sh", "--uninstall"],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        HOME: fixture.root,
        CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"),
        PATH: `${bin}:${testSystemPath}`,
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /is not managed by Cyberdeck; left untouched/);
  assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "user-owned\n");
});

test("a CYBERDECK_HOME that is not a Cyberdeck home is refused by install and skipped by uninstall", async (t) => {
  const fixture = await makeFixture(t);
  const unrelated = path.join(fixture.root, "documents");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "mine\n");
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  const fakeUname = path.join(bin, "uname");
  await writeFile(fakeUname, "#!/bin/sh\necho Linux\n");
  await chmod(fakeUname, 0o755);
  const env = {
    ...process.env,
    HOME: fixture.root,
    CYBERDECK_HOME: unrelated,
    PATH: `${bin}:${testSystemPath}`,
  };

  const install = await runWithClosedInput("bash", ["install.sh", "--dry-run"], { cwd: packageDirectory, env });
  assert.equal(install.code, 1);
  assert.match(install.stderr, /exists and is not a Cyberdeck home/);

  const uninstall = await runWithClosedInput("bash", ["install.sh", "--uninstall"], { cwd: packageDirectory, env });
  assert.equal(uninstall.code, 0);
  assert.match(uninstall.stdout, /is not a Cyberdeck home; left untouched/);
  assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "mine\n");
});

test("a piped dry-run clones nothing, writes nothing, and completes", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Linux\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  const bare = path.join(fixture.root, "bare.git");
  await execFileAsync("git", ["clone", "--quiet", "--bare", packageDirectory, bare]);
  const home = path.join(fixture.root, "home");
  await mkdir(home);
  const piped = await withNpmStub({
    env: {
      ...process.env,
      HOME: home,
      CYBERDECK_HOME: path.join(home, ".cyberdeck"),
      CYBERDECK_REPO_URL: `file://${bare}`,
      PATH: `${bin}:${testSystemPath}`,
    },
  });
  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn("bash", ["-s", "--", "--dry-run"], {
      cwd: fixture.root,
      env: piped.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
    readFile(path.join(packageDirectory, "install.sh")).then((script) => child.stdin.end(script));
  });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.match(stdout, /would clone file:.* to .*\.cyberdeck\/app/);
  assert.match(stdout, /would install the deck skill/);
  assert.deepEqual(await readdir(home), []);
});

test("a diverged or rewritten app clone is healed on re-run", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Linux\n"],
  ]) {
    const file = path.join(bin, name);
    await writeFile(file, script);
    await chmod(file, 0o755);
  }
  const bare = path.join(fixture.root, "bare.git");
  await execFileAsync("git", ["clone", "--quiet", "--bare", packageDirectory, bare]);
  const home = path.join(fixture.root, "home");
  const appDir = path.join(home, ".cyberdeck", "app");
  await mkdir(appDir, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  await execFileAsync("git", ["-C", appDir, "init", "--quiet"], { env: gitEnv });
  await mkdir(path.join(appDir, "bin"), { recursive: true });
  await writeFile(path.join(appDir, "bin", "cyberdeck-mcp.mjs"), "stale pre-rewrite clone\n");
  await writeFile(path.join(appDir, "unrelated.txt"), "old world\n");
  await execFileAsync("git", ["-C", appDir, "add", "-A"], { env: gitEnv });
  await execFileAsync("git", ["-C", appDir, "commit", "--quiet", "-m", "unrelated"], { env: gitEnv });
  await execFileAsync("git", ["-C", appDir, "remote", "add", "origin", bare], { env: gitEnv });

  const healed = await withNpmStub({
    env: {
      ...process.env,
      HOME: home,
      CYBERDECK_HOME: path.join(home, ".cyberdeck"),
      CYBERDECK_REPO_URL: `file://${bare}`,
      PATH: `${bin}:${testSystemPath}`,
    },
  });
  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn("bash", ["-s", "--"], {
      cwd: fixture.root,
      env: healed.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
    readFile(path.join(packageDirectory, "install.sh")).then((script) => child.stdin.end(script));
  });

  assert.equal(code, 0, stderr);
  assert.match(stdout, /updated .* to the published version/);
  const bareHead = (await execFileAsync("git", ["-C", bare, "rev-parse", "HEAD"])).stdout.trim();
  const appHead = (await execFileAsync("git", ["-C", appDir, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal(appHead, bareHead, "app now tracks the published head");
  assert.equal(existsSync(path.join(appDir, "bin", "cyberdeck-mcp.mjs")), true);
});

test("a failed update preserves the working app without recloning", async (t) => {
  const fixture = await makeFixture(t);
  const cyberdeckHome = path.join(fixture.root, ".cyberdeck");
  const appDir = path.join(cyberdeckHome, "app");
  const bin = path.join(fixture.root, "bin");
  await mkdir(path.join(appDir, ".git"), { recursive: true });
  await mkdir(path.join(appDir, "bin"));
  await mkdir(bin);
  const server = path.join(appDir, "bin", "cyberdeck-mcp.mjs");
  await writeFile(server, "working installation\n");
  const git = path.join(bin, "git");
  await writeFile(git, '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then exit 0; fi\necho "simulated fetch failure" >&2\nexit 1\n');
  await chmod(git, 0o755);
  await assert.rejects(execFileAsync("bash", ["-c", 'bash -s < "$1"', "test", path.join(packageDirectory, "install.sh")], {
    cwd: fixture.root,
    env: {
      ...process.env, HOME: fixture.root, CYBERDECK_HOME: cyberdeckHome,
      CYBERDECK_REPO_URL: "file:///unused-test-source", PATH: `${bin}:${testSystemPath}`,
    },
  }), (error) => {
    assert.match(error.stderr, /cannot update the app at/);
    return true;
  });
  assert.equal(await readFile(server, "utf8"), "working installation\n");
});

test("the shipped deck skill is concise and names the Cyberdeck routing contract", async () => {
  const skill = await readFile(path.join(packageDirectory, "skills", "deck", "SKILL.md"), "utf8");
  const metadata = await readFile(
    path.join(packageDirectory, "skills", "deck", "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(skill, /^---\nname: deck\ndescription: .+\n---/);
  assert.doesNotMatch(skill, /TODO/);
  for (const term of [
    "`research`",
    "`implement`",
    "`working_directory`",
    "`implemented_by`",
    "`cyberdeck://catalog`",
    "Retry only upward in intelligence",
  ]) {
    assert.ok(skill.includes(term), `missing ${term}`);
  }
  assert.match(metadata, /default_prompt: "Use \$deck /);
});

test("the installer refuses to overwrite an unmanaged deck skill", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  const fakePi = path.join(bin, "pi");
  await writeFile(
    fakePi,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n",
  );
  await chmod(fakePi, 0o755);
  const existing = path.join(fixture.root, ".claude", "skills", "deck");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "SKILL.md"), "user-owned\n");

  const { code, stderr } = await runWithClosedInput("bash", ["install.sh", "--dry-run"], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      HOME: fixture.root,
      CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"),
      PATH: `${bin}:${testSystemPath}`,
    },
  });

  assert.equal(code, 1);
  assert.match(stderr, /cannot install the deck skill .* path already exists and is not managed/);
  assert.equal(await readFile(path.join(existing, "SKILL.md"), "utf8"), "user-owned\n");
});

test("the installer contains no OpenCode or Grok Build registration and no hardcoded model IDs", async () => {
  const installer = await readFile(path.join(packageDirectory, "install.sh"), "utf8");
  assert.doesNotMatch(installer, /opencode|grok mcp|\.grok/i);
  assert.doesNotMatch(installer, /x-ai\/|moonshotai\/|deepseek\//);
});

test("Herdr opt-in installs and updates only its managed coordinator and preserves Pi settings", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  const trace = path.join(fixture.root, "herdr-calls");
  for (const [name, script] of [
    ["pi", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 0.84.2"; else echo ready; fi\n'],
    ["uname", "#!/bin/sh\necho Linux\n"],
    ["herdr", `#!/bin/sh\necho "$*" >> '${trace}'\n`],
  ]) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  const agent = path.join(fixture.root, "agent");
  await mkdir(agent);
  const settings = '{"theme":"user-choice"}\n';
  await writeFile(path.join(agent, "settings.json"), settings);
  const env = { ...process.env, HOME: fixture.root, CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"), PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${testSystemPath}` };
  const target = path.join(agent, "extensions/cyberdeck-coordinator");
  await execFileAsync("bash", ["install.sh", "--codex-only", "--herdr", "--dry-run"], { cwd: packageDirectory, env });
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(trace), false);
  await execFileAsync("bash", ["install.sh", "--codex-only", "--herdr"], { cwd: packageDirectory, env });
  const loader = await readFile(path.join(target, "index.js"), "utf8");
  assert.match(loader, /pi\/coordinator.js/);
  assert.ok(loader.includes(await realpath(path.join(fixture.root, ".cyberdeck/cyberdeck.config.json"))));
  assert.equal(await readFile(trace, "utf8"), "integration install pi\n");
  await execFileAsync("bash", ["install.sh", "--codex-only"], { cwd: packageDirectory, env });
  assert.equal(await readFile(path.join(target, "index.js"), "utf8"), loader);
  assert.equal(await readFile(path.join(agent, "settings.json"), "utf8"), settings);
  const uninstallEnv = { ...env };
  delete uninstallEnv.PI_CODING_AGENT_DIR;
  await execFileAsync("bash", ["install.sh", "--codex-only", "--uninstall"], { cwd: packageDirectory, env: uninstallEnv });
  assert.equal(existsSync(target), false);
  assert.equal(await readFile(path.join(agent, "settings.json"), "utf8"), settings);
});

test("every install updates Pi to the npm latest tag, including an existing Pi", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, "node"));
  await writeFile(path.join(bin, "uname"), "#!/bin/sh\necho Linux\n");
  await chmod(path.join(bin, "uname"), 0o755);
  const trace = path.join(fixture.root, "npm-calls");
  const env = {
    ...process.env,
    HOME: fixture.root,
    CYBERDECK_HOME: path.join(fixture.root, ".cyberdeck"),
    CYBERDECK_NPM_TRACE: trace,
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const missing = await execFileAsync("bash", ["install.sh", "--dry-run", "--codex-only", "--provider", "openrouter"], {
    cwd: packageDirectory,
    env,
  });
  assert.equal(missing.stderr, "");
  assert.match(missing.stdout, /would run: npm install -g @earendil-works\/pi-coding-agent@latest/);
  assert.match(missing.stdout, /would install the latest Pi/);
  assert.doesNotMatch(missing.stdout, /pin-pi|0\.84\.2/);

  await writeFile(path.join(bin, "pi"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n");
  await chmod(path.join(bin, "pi"), 0o755);
  const present = await execFileAsync("bash", ["install.sh", "--dry-run", "--codex-only", "--provider", "openrouter"], {
    cwd: packageDirectory,
    env,
  });
  assert.equal(present.stderr, "");
  assert.match(present.stdout, /would set pi 0\.84\.2 to the latest release/);
  assert.match(present.stdout, /would run: npm install -g @earendil-works\/pi-coding-agent@latest/);

  await writeFile(path.join(bin, "pi"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '1.1.0-rc.1'; else echo ready; fi\n");
  const prerelease = await execFileAsync("bash", ["install.sh", "--dry-run", "--codex-only", "--provider", "openrouter"], {
    cwd: packageDirectory,
    env,
  });
  assert.match(prerelease.stdout, /would set pi 1\.1\.0-rc\.1 to the latest release/);

  await writeFile(path.join(bin, "pi"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n");
  const installed = await execFileAsync("bash", ["install.sh", "--codex-only", "--provider", "openrouter"], {
    cwd: packageDirectory,
    env,
  });
  assert.equal(installed.stderr, "");
  assert.match(installed.stdout, /pi 0\.84\.2 is current/);
  assert.match(await readFile(trace, "utf8"), /install -g @earendil-works\/pi-coding-agent@latest/);

  await writeFile(path.join(bin, "pi"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo nope; else echo ready; fi\n");
  const unreadable = await execFileAsync("bash", ["install.sh", "--codex-only", "--provider", "openrouter"], {
    cwd: packageDirectory,
    env,
  });
  assert.match(unreadable.stdout, /version could not be read/);
  assert.doesNotMatch(unreadable.stdout, /unknown/);
});
