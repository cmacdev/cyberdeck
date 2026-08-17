import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const fakePi = path.join(bin, "pi");
  await writeFile(
    fakePi,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n",
  );
  await chmod(fakePi, 0o755);

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
  const fakePi = path.join(bin, "pi");
  await writeFile(
    fakePi,
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'pi 0.84.2'; else echo ready; fi\n",
  );
  await chmod(fakePi, 0o755);
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

test("the installer contains no OpenCode or Grok Build registration", async () => {
  const installer = await readFile(path.join(packageDirectory, "install.sh"), "utf8");
  assert.doesNotMatch(installer, /opencode|grok mcp|\.grok/i);
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
