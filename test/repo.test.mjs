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
  "~/.pi/agent/settings.json": "$PI_SETTINGS",
  "~/.pi/agent/auth.json": "$PI_AGENT_DIR/auth.json",
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

test("the README role table mirrors the shipped configuration", async () => {
  const rows = tableRows(await read("README.md"), "## Tools and roles");
  const shipped = JSON.parse(await read("cyberdeck.config.json"));
  let expectedRows = 0;
  for (const [profileName, profile] of Object.entries(shipped.profiles)) {
    const tool = profileName === "implementation" ? "implement" : "research";
    for (const [roleName, role] of Object.entries(profile.roles)) {
      expectedRows += 1;
      const row = rows.find((cells) => cells[0] === `\`${tool}\`` && cells[1].startsWith(`\`${roleName}\``));
      assert.ok(row, `README lacks a row for ${tool} ${roleName}`);
      assert.equal(row[2], `\`${role.model}\``, `${tool} ${roleName} model`);
      assert.equal(row[1].includes("(default)"), roleName === profile.defaultRole, `${tool} ${roleName} default marker`);
    }
  }
  assert.equal(rows.length, expectedRows);
});

test("the README names the pinned Pi version", async () => {
  const [, pinned] = (await read("install.sh")).match(/^PINNED_PI="([^"]+)"/m);
  assert.ok((await read("README.md")).includes(`Pi ${pinned} `), `README does not mention Pi ${pinned}`);
});

test("the deck skill names exactly the shipped roles", async () => {
  const skill = await read("skills/deck/SKILL.md");
  const shipped = JSON.parse(await read("cyberdeck.config.json"));
  for (const profile of Object.values(shipped.profiles)) {
    for (const role of Object.keys(profile.roles)) {
      assert.ok(skill.includes(`\`${role}\``), `SKILL.md does not mention role ${role}`);
    }
  }
});

test("code carries no comments", async () => {
  const files = ["install.sh"];
  for (const directory of ["bin", "desktop", "fixtures", "src", "test"]) {
    for (const name of await readdir(path.join(packageDirectory, directory), { recursive: true })) {
      if (name.endsWith(".mjs")) files.push(path.join(directory, name));
    }
  }
  for (const file of files) {
    const comment = file.endsWith(".sh") ? /(^|\s)#(?!!)/ : /(^|\s)\/[/*]/;
    (await read(file)).split("\n").forEach((line, index) => {
      assert.ok(!comment.test(line), `${file}:${index + 1} has a comment: ${line.trim()}`);
    });
  }
});
