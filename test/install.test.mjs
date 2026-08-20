import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { makeFixture, packageDirectory } from "./helpers.mjs";

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
  const piSettings = JSON.parse(await readFile(path.join(fixture.root, ".pi", "agent", "settings.json"), "utf8"));
  assert.equal(piSettings.defaultProvider, "openrouter");
  assert.equal(piSettings.defaultModel, "x-ai/grok-4.6");
  assert.equal(piSettings.defaultThinkingLevel, "high");
  assert.equal(piSettings.cyberdeckDefaults, true);
  assert.equal(piSettings.enableInstallTelemetry, false);
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
  const userRouting = { providers: { openrouter: { compat: { openRouterRouting: { order: ["xai"] } } } } };
  await writeFile(modelsPath, `${JSON.stringify(userRouting, null, 2)}\n`);
  const piSettingsPath = path.join(fixture.root, ".pi", "agent", "settings.json");
  const userSettings = { defaultModel: "user-choice", theme: "dark" };
  await writeFile(piSettingsPath, `${JSON.stringify(userSettings, null, 2)}\n`);

  await execFileAsync("bash", ["install.sh"], { cwd: packageDirectory, env });
  assert.deepEqual(
    JSON.parse(await readFile(modelsPath, "utf8")).providers.openrouter.compat.openRouterRouting,
    { order: ["xai"], zdr: true, data_collection: "deny" },
  );
  assert.deepEqual(JSON.parse(await readFile(piSettingsPath, "utf8")), userSettings, "an existing default model is never overwritten");
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
  assert.deepEqual(JSON.parse(await readFile(piSettingsPath, "utf8")), userSettings, "user settings survive uninstall untouched");
  for (const target of [".claude/skills/deck", ".codex/skills/deck", ".cyberdeck"]) {
    assert.equal(existsSync(path.join(fixture.root, target)), false, `${target} should be gone`);
  }
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
  assert.match(stdout, /updated .* to the published version|recloned/);
  const bareHead = (await execFileAsync("git", ["-C", bare, "rev-parse", "HEAD"])).stdout.trim();
  const appHead = (await execFileAsync("git", ["-C", appDir, "rev-parse", "HEAD"])).stdout.trim();
  assert.equal(appHead, bareHead, "app now tracks the published head");
  assert.equal(existsSync(path.join(appDir, "bin", "cyberdeck-mcp.mjs")), true);
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
