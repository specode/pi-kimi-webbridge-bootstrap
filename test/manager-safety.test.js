import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { validateSkillManifest, WebbridgeManager } from "../src/manager.js";
import { runChecked } from "../src/process.js";

const manifest = (description = "Browser control.") =>
  `---\nname: kimi-webbridge\ndescription: ${description}\nmetadata:\n  version: "1.2.3"\n---\n`;

async function fixture(t, platform) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-safety-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({
    agentDir: root,
    userHomeDir: root,
    platform,
    arch: "x64",
    fetchImpl: async () => { throw new Error("unexpected network request"); },
    runImpl: async (_command, args) => {
      assert.deepEqual(args, ["status"]);
      return { code: 0, stdout: JSON.stringify({ running: true, version: "v1.2.3" }), stderr: "" };
    },
  });
  manager.fetchMetadata = async () => ({ version: "v1.2.3" });
  await mkdir(path.dirname(manager.cliPath), { recursive: true });
  await writeFile(manager.cliPath, "fixture CLI, never executed\n");
  await mkdir(manager.legacySkillRoot, { recursive: true });
  await writeFile(path.join(manager.legacySkillRoot, "SKILL.md"), manifest("Old skill."));
  await manager.hasSkill();
  return { root, manager };
}

async function candidate(root, source = manifest("New skill.")) {
  const directory = await mkdtemp(path.join(root, "candidate-"));
  await writeFile(path.join(directory, "SKILL.md"), source);
  return directory;
}

async function serveArchive(root, manager, source) {
  const directory = await mkdtemp(path.join(root, "archive-fixture-"));
  await mkdir(path.join(directory, "kimi-webbridge"));
  await writeFile(path.join(directory, "kimi-webbridge", "SKILL.md"), source);
  const archivePath = path.join(root, "skill.tar.gz");
  await runChecked("tar", ["--format=ustar", "-czf", archivePath, "-C", directory, "kimi-webbridge"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const archive = await readFile(archivePath);
  manager.fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/cdn\.kimi\.com\/webbridge\/v1\.2\.3\/skills\//);
    return new Response(archive);
  };
}

async function activeSource(manager) {
  assert.equal(await manager.hasSkill(), true);
  return readFile(path.join(manager.skillRoot, "SKILL.md"), "utf8");
}

function freshManager(root, platform) {
  return new WebbridgeManager({ agentDir: root, userHomeDir: root, platform });
}

test("manifest validation rejects malformed YAML and non-string descriptions", () => {
  for (const description of ['"unterminated', "'unterminated", "null", "~", "true", "42", "[]", "{}", '""', '"   "', "|"]) {
    assert.throws(() => validateSkillManifest(manifest(description)), /invalid/, description);
  }
  for (const source of [
    manifest().replace("metadata:", "description: Duplicate\nmetadata:"),
    manifest().replace('  version: "1.2.3"', '  version: "1.2.3"\n  version: "1.2.4"'),
    manifest().replace('metadata:\n  version: "1.2.3"', "metadata: null"),
    manifest().replace('metadata:\n  version: "1.2.3"', "metadata: []"),
    manifest().replace('version: "1.2.3"', "version: 123"),
    "---\n[]\n---\n",
    "---\nnull\n---\n",
    "---\n---\n",
  ]) {
    assert.throws(() => validateSkillManifest(source), /invalid/, source);
  }
});

test("manifest validation accepts valid quoting, comments, CRLF and block scalars", () => {
  for (const description of [
    '"Browser: control # safely"',
    '"Browser \\"control\\""',
    "'Browser: it''s ready'",
    "Browser control. # comment",
    "|\n  Browser control.\n  Second line.",
    ">-\n  Browser control.\n  Second line.",
  ]) {
    assert.equal(validateSkillManifest(manifest(description), "v1.2.3"), "v1.2.3");
  }
  assert.equal(validateSkillManifest(manifest().replace(/\n/g, "\r\n")), "v1.2.3");
});

test("manifest validation rejects a BOM that would hide the frontmatter from Pi", () => {
  assert.throws(() => validateSkillManifest(`\uFEFF${manifest()}`), /byte order mark/);
});

test("manifest validation rejects lines Pi would treat as the closing delimiter", () => {
  for (const source of [
    manifest().replace("description:", "---optional: true\ndescription:"),
    manifest().replace("description:", "\r---optional: true\ndescription:"),
  ]) {
    assert.throws(() => validateSkillManifest(source), /ambiguous frontmatter delimiter/, JSON.stringify(source));
  }
});

test("accepted manifests load the same name, description and version in Pi", () => {
  for (const [source, description] of [
    [manifest(), "Browser control."],
    [manifest().replace(/\n/g, "\r\n"), "Browser control."],
    [manifest().replace(/\n/g, "\r"), "Browser control."],
    [manifest("|\n  Browser control.\n  ---\n  Second line."), "Browser control.\n---\nSecond line.\n"],
    [manifest().replace("metadata:", "license: Proprietary\nmetadata:\n  author: Moonshot AI"), "Browser control."],
  ]) {
    assert.equal(validateSkillManifest(source, "v1.2.3"), "v1.2.3", JSON.stringify(source));
    const { frontmatter } = parseFrontmatter(source);
    assert.equal(frontmatter.name, "kimi-webbridge");
    assert.equal(frontmatter.description, description);
    assert.equal(frontmatter.metadata.version, "1.2.3");
  }
});

test("manifest validation accepts optional Agent Skills fields", () => {
  const source = manifest()
    .replace("metadata:", "license: Proprietary\nallowed-tools: Bash\nmetadata:\n  author: Moonshot AI")
    .replace("---\nname:", "---\ncompatibility: Requires a browser\nname:");
  assert.equal(validateSkillManifest(source, "v1.2.3"), "v1.2.3");
});

for (const platform of ["darwin", "linux", "win32"]) {
  test(`invalid downloaded YAML leaves the cached skill active on ${platform}`, async (t) => {
    const { root, manager } = await fixture(t, platform);
    await manager.publishSkill(await candidate(root, manifest("Old skill.")), "v1.2.3", "a".repeat(64));
    const previousPublication = await manager.readSkillPublication();
    const previousPointer = await readFile(manager.activeSkillPath, "utf8");
    await serveArchive(root, manager, manifest('"unterminated'));

    await assert.rejects(manager.ensure({ force: true }), /invalid YAML/);
    assert.equal(await manager.readSkillPublication(), previousPublication);
    assert.equal(await readFile(manager.activeSkillPath, "utf8"), previousPointer);
    assert.equal(await activeSource(freshManager(root, platform)), manifest("Old skill."));
  });

  test(`state write failure before publication remains fatal on ${platform}`, async (t) => {
    const { root, manager } = await fixture(t, platform);
    t.mock.method(manager, "writeState", async () => { throw new Error("injected initial state write failure"); });

    await assert.rejects(manager.ensure({ force: true }), /injected initial state write failure/);
    assert.equal(await activeSource(freshManager(root, platform)), manifest("Old skill."));
  });

  test(`state write failure after publication still reports skillUpdated on ${platform}`, async (t) => {
    const { root, manager } = await fixture(t, platform);
    await serveArchive(root, manager, manifest("New skill."));
    const writeState = manager.writeState.bind(manager);
    let writes = 0;
    t.mock.method(manager, "writeState", async (state) => {
      if (++writes > 1) throw new Error("injected state write failure");
      await writeState(state);
    });

    const result = await manager.ensure({ force: true });
    assert.equal(result.kind, "updated");
    assert.equal(result.skillUpdated, true);
    assert.match(result.warnings.join("\n"), /bookkeeping failed.*injected state write failure/);
    assert.equal(await activeSource(freshManager(root, platform)), manifest("New skill."));
    // Cleanup still runs even when the final state write fails.
    const lock = await manager.acquireLock(false);
    assert.ok(lock);
    await lock.release();
  });

  test(`lock release failure cannot hide a committed publication on ${platform}`, async (t) => {
    const { root, manager } = await fixture(t, platform);
    await serveArchive(root, manager, manifest("New skill."));
    const acquireLock = manager.acquireLock.bind(manager);
    t.mock.method(manager, "acquireLock", async (wait) => {
      const lock = await acquireLock(wait);
      return { release: async () => {
        await lock.release();
        throw new Error("injected lock cleanup failure");
      } };
    });

    const result = await manager.ensure({ force: true });
    assert.equal(result.skillUpdated, true);
    assert.match(result.warnings.join("\n"), /releasing the update lock failed.*injected lock cleanup failure/);
    assert.equal(await activeSource(freshManager(root, platform)), manifest("New skill."));
  });
}

for (const platform of ["darwin", "linux"]) {
  test(`failure before the symlink commit leaves both selectors unchanged on ${platform}`, async (t) => {
    const { root, manager } = await fixture(t, platform);
    await manager.publishSkill(await candidate(root, manifest("Old skill.")), "v1.2.3", "a".repeat(64));
    const previousPointer = await readFile(manager.activeSkillPath, "utf8");
    const previousPublication = await manager.readSkillPublication();
    t.mock.method(manager, "activateSkillRoot", async () => { throw new Error("injected activation failure"); });
    await serveArchive(root, manager, manifest("New skill."));

    await assert.rejects(manager.ensure({ force: true }), /injected activation failure/);
    assert.equal(await readFile(manager.activeSkillPath, "utf8"), previousPointer);
    assert.equal(await manager.readSkillPublication(), previousPublication);
    assert.equal(await activeSource(freshManager(root, platform)), manifest("Old skill."));
  });

  test(`active.json failure after the symlink commit reports success with a warning on ${platform}`, async (t) => {
    const { root, manager } = await fixture(t, platform);
    // A directory forces active.json's atomic rename to fail without affecting current.
    await mkdir(manager.activeSkillPath);
    await serveArchive(root, manager, manifest("New skill."));

    const result = await manager.ensure({ force: true });
    assert.equal(result.kind, "updated");
    assert.equal(result.skillUpdated, true);
    assert.match(result.warnings.join("\n"), /writing active.json failed/);
    assert.equal(await activeSource(freshManager(root, platform)), manifest("New skill."));
    assert.equal(await readFile(path.join(manager.legacySkillRoot, "SKILL.md"), "utf8"), manifest("Old skill."));
  });
}

test("Windows pointer write failure remains fatal and preserves the cached skill", async (t) => {
  const { root, manager } = await fixture(t, "win32");
  await mkdir(manager.activeSkillPath);
  await serveArchive(root, manager, manifest("New skill."));

  await assert.rejects(manager.ensure({ force: true }), (error) => ["EISDIR", "EEXIST", "EPERM"].includes(error.code));
  assert.equal(await activeSource(freshManager(root, "win32")), manifest("Old skill."));
});
