import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { packageDirectory } from "./helpers.mjs";

const read = (file) => readFile(path.join(packageDirectory, file), "utf8");

function tableRows(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `${heading} is missing`);
  const section = markdown.slice(start + heading.length).split(/\n#{1,6} /)[0];
  return section
    .split("\n")
    .filter((line) => /^\| [^-]/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split(" | ").map((cell) => cell.trim()));
}

const DOC_PATH_VARIABLES = {
  "~/.claude.json": "$CLAUDE_CONFIG",
  "~/.claude/settings.json": "$CLAUDE_SETTINGS",
  "~/.codex/config.toml": "$CODEX_CONFIG",
  "~/.pi/agent/models.json": "$PI_MODELS",
  "~/.pi/agent/auth.json": "$PI_AGENT_DIR/auth.json",
  "~/.cyberdeck/cyberdeck.config.json": "$CONFIG_PATH",
};

function keyFragments(key) {
  return key
    .split(/<[^>]*>|…|~\/\S*/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 6);
}

function keyVariables(key) {
  return [...key.matchAll(/~\/[\w./-]+/g)].map(([docPath]) => {
    const variable = DOC_PATH_VARIABLES[docPath];
    assert.ok(variable, `no installer variable mapped for ${docPath}; extend DOC_PATH_VARIABLES`);
    return variable;
  });
}

function rowMatches(row, message) {
  return [...row[0].matchAll(/`([^`]+)`/g)].some(([, key]) => {
    const fragments = keyFragments(key);
    return (
      fragments.length > 0 &&
      fragments.every((fragment) => message.includes(fragment)) &&
      keyVariables(key).every((variable) => message.includes(variable))
    );
  });
}

test("every installer stop has an install-helper.md fix and every documented stop exists in the installer", async () => {
  const installer = await read("install.sh");
  const stops = [...installer.matchAll(/\bdie "((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  assert.ok(stops.length >= 10, `only ${stops.length} die messages found`);
  const rows = tableRows(await read("install-helper.md"), "## If the installer stops").filter(
    (row) => !row[0].includes("(not a stop)"),
  );
  for (const row of rows) {
    assert.ok(stops.some((message) => rowMatches(row, message)), `install-helper.md row without stop: ${row[0]}`);
  }
  for (const message of stops) {
    assert.ok(rows.some((row) => rowMatches(row, message)), `stop without install-helper.md row: ${message}`);
  }
});

test("the README model and kind tables mirror the shipped configuration", async () => {
  const readme = await read("README.md");
  const shipped = JSON.parse(await read("cyberdeck.config.json"));
  const rows = tableRows(readme, "## Tools and models");
  assert.deepEqual(rows.map((row) => row[0]), Object.keys(shipped.models).map((name) => `\`${name}\``));
  for (const [name, model] of Object.entries(shipped.models)) {
    const row = rows.find((cells) => cells[0] === `\`${name}\``);
    const openrouter = model.providers.openrouter;
    assert.deepEqual(row.slice(1, 3), [model.tier, model.family], name);
    assert.equal(row[3], openrouter
      ? openrouter.thinking.map((level) => (level === model.defaultThinking ? `**${level}**` : level)).join(", ") || "none"
      : "–", name);
    const venice = model.providers.venice;
    const veniceThinking = venice && (!openrouter || venice.thinking.join() !== openrouter.thinking.join())
      ? ` (${venice.thinking.length ? `thinking: ${venice.thinking.join(", ")}` : "no thinking control"})`
      : "";
    assert.deepEqual(row.slice(4, 6), [openrouter ? `\`${openrouter.id}\`` : "–", venice ? `\`${venice.id}\`${veniceThinking}` : "–"], name);
  }
  const kinds = tableRows(readme, "### Kinds");
  assert.deepEqual(
    kinds.map((row) => row.slice(0, 3)),
    Object.entries(shipped.kinds).map(([name, kind]) => [`\`${name}\``, `\`${kind.model}\``, kind.preamble]),
  );
});

test("the installer installs the latest Pi and does not pin a version", async () => {
  const installer = await read("install.sh");
  const readme = await read("README.md");
  const helper = await read("install-helper.md");
  assert.equal(installer.includes("PINNED_PI"), false);
  assert.equal(installer.includes("--pin-pi"), false);
  assert.match(installer, /npm install -g "\$PI_PACKAGE@latest"/);
  assert.match(installer, /would set pi/);
  assert.match(installer, /set pi from/);
  assert.equal(installer.includes("updated pi from"), false);
  assert.match(readme, /latest Pi/);
  assert.equal(readme.includes("only when `pi` is absent"), false);
  assert.equal(helper.includes("does not upgrade"), false);
  assert.equal(readme.includes("--pin-pi"), false);
  assert.equal(helper.includes("--pin-pi"), false);
  assert.equal(helper.includes("tested version"), false);
});

test("the deck skill names exactly the shipped kinds", async () => {
  const skill = await read("skills/deck/SKILL.md");
  const shipped = JSON.parse(await read("cyberdeck.config.json"));
  for (const name of Object.keys(shipped.kinds)) {
    assert.ok(skill.includes(`\`${name}\``), `SKILL.md does not mention ${name}`);
  }
});

test("code carries no comments", async () => {
  const files = ["install.sh"];
  for (const directory of ["bin", "fixtures", "pi", "src", "test"]) {
    for (const name of await readdir(path.join(packageDirectory, directory), { recursive: true })) {
      if (/\.[cm]?js$/.test(name)) files.push(path.join(directory, name));
    }
  }
  for (const file of files) {
    const comment = file.endsWith(".sh") ? /(^|\s)#(?!!)/ : /(^|\s)\/[/*]/;
    (await read(file)).split("\n").forEach((line, index) => {
      assert.ok(!comment.test(line), `${file}:${index + 1} has a comment: ${line.trim()}`);
    });
  }
});
