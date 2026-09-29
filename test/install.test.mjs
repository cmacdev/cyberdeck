import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { makeFixture, packageDirectory } from "./helpers.mjs";
import { inferenceKey } from "../fixtures/venice-api.mjs";

const execFileAsync = promisify(execFile);
const testSystemPath = [
  path.dirname(process.execPath),
  "/run/current-system/sw/bin",
  "/usr/bin",
  "/bin",
].join(":");

function runWithClosedInput(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
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
  assert.equal(existsSync(path.join(fixture.root, ".claude/skills/deck")), false);
  assert.ok(existsSync(path.join(fixture.root, ".codex/skills/deck/SKILL.md")));
  await writeFile(path.join(fixture.root, ".claude.json"), JSON.stringify({ mcpServers: { cyberdeck: {}, other: {} } }));
  await execFileAsync("bash", ["install.sh", "--codex-only", "--uninstall"], { cwd: packageDirectory, env });
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, ".claude.json"), "utf8")).mcpServers, { other: {} });
  assert.equal(existsSync(invoked), false);
});

test("Venice install, repeat install, and provider switching preserve custom policy and credentials", async (t) => {
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
  const policy = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(policy.provider, "venice");
  assert.equal(policy.pi.stateDirectory, agentDirectory);
  policy.limits.maxTaskCharacters = 1234;
  await writeFile(configPath, JSON.stringify(policy));
  const authPath = path.join(agentDirectory, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  assert.deepEqual(auth.venice, { type: "api_key", key: inferenceKey });
  const repeated = await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.match(repeated.stdout, /provider: Venice/);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).limits.maxTaskCharacters, 1234);
  await execFileAsync("bash", ["install.sh", "--provider", "openrouter"], { cwd: packageDirectory, env });
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).provider, "openrouter");
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), auth);
  await execFileAsync("bash", ["install.sh", "--provider", "venice"], { cwd: packageDirectory, env });
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).provider, "venice");
  const models = JSON.parse(await readFile(path.join(agentDirectory, "models.json"), "utf8"));
  assert.equal(models.providers.openrouter.compat.openRouterRouting.zdr, true);
  assert.equal(models.providers.venice.models.length, 3);
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
  assert.doesNotMatch(stdout, /OpenCode|Grok Build/);
  assert.doesNotMatch(stdout, /would run: open|would run: zip/);
});

test("the macOS dry-run uses shared Codex config and prepares only Claude Desktop", async (t) => {
  const fixture = await makeFixture(t);
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  for (const [name, script] of [
    ["pi", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n"],
    ["uname", "#!/bin/sh\necho Darwin\n"],
    ["open", "#!/bin/sh\nexit 0\n"],
    ["zip", "#!/bin/sh\nexit 0\n"],
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
  assert.match(stdout, /Claude Desktop: would build .*cyberdeck\.mcpb and open its installation dialog/);
  assert.doesNotMatch(stdout, /desktop app detection or installation was attempted/);
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
    `${JSON.stringify({ permissions: { allow: ["Bash(ls*)"] } }, null, 2)}\n`,
  );
  const modelsPath = path.join(fixture.root, ".pi", "agent", "models.json");
  await mkdir(path.dirname(modelsPath), { recursive: true });
  const userRouting = { providers: { openrouter: { compat: { openRouterRouting: { order: ["xai"], zdr: true, data_collection: "deny" } } } } };
  await writeFile(modelsPath, `${JSON.stringify(userRouting, null, 2)}\n`);
  const piSettingsPath = path.join(fixture.root, ".pi", "agent", "settings.json");
  const userSettings = { theme: "dark" };
  await writeFile(piSettingsPath, `${JSON.stringify(userSettings, null, 2)}\n`);

  await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.deepEqual(
    JSON.parse(await readFile(modelsPath, "utf8")).providers.openrouter.compat.openRouterRouting,
    { order: ["xai"], zdr: true, data_collection: "deny" },
  );
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
  const codex = await readFile(path.join(fixture.root, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "keep-me"$/m);
  assert.doesNotMatch(codex, /cyberdeck/);
  assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), userRouting);
  assert.deepEqual(JSON.parse(await readFile(piSettingsPath, "utf8")), legacySettings, "uninstall preserves settings marked by an older installer");
  for (const target of [".claude/skills/deck", ".codex/skills/deck", ".cyberdeck"]) {
    assert.equal(existsSync(path.join(fixture.root, target)), false, `${target} should be gone`);
  }
});

test("an unavailable configured Pi stops installation with a repair path", async (t) => {
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
  const canonicalConfigPath = await realpath(configPath);
  const env = { ...process.env, HOME: fixture.root, CYBERDECK_HOME: cyberdeckHome, PATH: `${bin}:${testSystemPath}` };
  delete env.OPENROUTER_API_KEY;
  await assert.rejects(execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env }), (error) => {
    assert.ok(error.stderr.includes(`configured Pi command '${config.pi.command}' is not executable`));
    assert.ok(error.stderr.includes(`Set pi.command in ${canonicalConfigPath} to '${path.join(bin, "pi")}'`));
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), config);
  config.pi.command = path.join(bin, "pi");
  await writeFile(configPath, JSON.stringify(config));
  const { stdout } = await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.match(stdout, /verified: resolved config loads/);
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
  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn("bash", ["-s", "--", "--dry-run"], {
      cwd: fixture.root,
      env: {
        ...process.env,
        HOME: home,
        CYBERDECK_HOME: path.join(home, ".cyberdeck"),
        CYBERDECK_REPO_URL: `file://${bare}`,
        PATH: `${bin}:${testSystemPath}`,
      },
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

  const { code, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn("bash", ["-s", "--"], {
      cwd: fixture.root,
      env: {
        ...process.env,
        HOME: home,
        CYBERDECK_HOME: path.join(home, ".cyberdeck"),
        CYBERDECK_REPO_URL: `file://${bare}`,
        PATH: `${bin}:${testSystemPath}`,
      },
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
    "`mechanical`",
    "`gritty`",
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

test("the Claude Desktop bundle manifest is macOS-only and collects a workspace root", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "desktop", "claude-manifest.json"), "utf8"),
  );
  const pkg = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.server.type, "node");
  assert.equal(manifest.server.entry_point, "desktop/claude-server.mjs");
  assert.deepEqual(manifest.compatibility.platforms, ["darwin"]);
  assert.equal(manifest.user_config.workspace_root.type, "directory");
  assert.equal(manifest.user_config.workspace_root.required, true);
  assert.equal(
    manifest.server.mcp_config.env.CYBERDECK_WORKSPACE_ROOT,
    "${user_config.workspace_root}",
  );
  assert.ok(manifest.privacy_policies.includes("https://openrouter.ai/privacy"));
});

test("the installer contains no OpenCode or Grok Build registration and no hardcoded model IDs", async () => {
  const installer = await readFile(path.join(packageDirectory, "install.sh"), "utf8");
  assert.doesNotMatch(installer, /opencode|grok mcp|\.grok/i);
  assert.doesNotMatch(installer, /x-ai\/|moonshotai\/|deepseek\//);
});

test("the Claude Desktop launcher prefers the installed policy", async (t) => {
  const fixture = await makeFixture(t);
  const home = path.join(fixture.root, "home");
  const cyberdeckHome = path.join(home, ".cyberdeck");
  await mkdir(cyberdeckHome, { recursive: true });
  const pi = path.join(fixture.root, "pi");
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await writeFile(path.join(cyberdeckHome, "pi-command"), `${pi}\n`);
  const policy = JSON.parse(
    await readFile(path.join(packageDirectory, "cyberdeck.config.json"), "utf8"),
  );
  delete policy.$schema;
  policy.limits.maxTaskCharacters = 1234;
  await writeFile(
    path.join(cyberdeckHome, "cyberdeck.config.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
  );

  const { code, stderr } = await runWithClosedInput(
    process.execPath,
    [path.join(packageDirectory, "desktop", "claude-server.mjs")],
    {
      cwd: fixture.workspace,
      env: { ...process.env, HOME: home, CYBERDECK_WORKSPACE_ROOT: fixture.workspace },
    },
  );

  assert.equal(code, 0);
  assert.equal(stderr, "");
  const generated = JSON.parse(
    await readFile(path.join(cyberdeckHome, "claude-desktop.config.json"), "utf8"),
  );
  assert.equal(generated.limits.maxTaskCharacters, 1234, "installed policy edits reach Claude Desktop");
  assert.deepEqual(generated.workspaceRoots, [fixture.workspace]);
});

test("the Claude Desktop launcher creates a scoped config with the recorded Pi path", async (t) => {
  const fixture = await makeFixture(t);
  const home = path.join(fixture.root, "home");
  const cyberdeckHome = path.join(home, ".cyberdeck");
  await mkdir(cyberdeckHome, { recursive: true });
  const pi = path.join(fixture.root, "pi");
  await writeFile(pi, "#!/bin/sh\nexit 0\n");
  await chmod(pi, 0o755);
  await writeFile(path.join(cyberdeckHome, "pi-command"), `${pi}\n`);

  const { code, stderr } = await runWithClosedInput(
    process.execPath,
    [path.join(packageDirectory, "desktop", "claude-server.mjs")],
    {
      cwd: fixture.workspace,
      env: {
        ...process.env,
        HOME: home,
        CYBERDECK_WORKSPACE_ROOT: fixture.workspace,
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(stderr, "");
  const generated = JSON.parse(
    await readFile(path.join(cyberdeckHome, "claude-desktop.config.json"), "utf8"),
  );
  assert.deepEqual(generated.workspaceRoots, [fixture.workspace]);
  assert.equal(generated.pi.command, pi);
  assert.equal(generated.artifactDirectory, path.join(cyberdeckHome, "claude-desktop-runs"));
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
