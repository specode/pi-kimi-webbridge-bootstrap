import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  compareVersions,
  isUpdateDue,
  platformKey,
  validateArchiveEntries,
  validateSkillArchive,
  validateSkillManifest,
  WebbridgeManager,
} from "../src/manager.js";
import { runChecked } from "../src/process.js";

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512);
  const writeOctal = (value, offset, length) => {
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
  };
  header.write(name, 0, 100, "utf8");
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(size, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

test("maps supported WebBridge release platforms", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformKey("darwin", "x64"), "darwin-amd64");
  assert.equal(platformKey("linux", "x64"), "linux-amd64");
  assert.equal(platformKey("win32", "x64"), "windows-amd64");
  assert.equal(platformKey("freebsd", "x64"), undefined);
});

test("compares release versions without treating prerelease text as a fourth number", () => {
  assert.equal(compareVersions("v1.11.5", "v1.12.0"), -1);
  assert.equal(compareVersions("1.11.5", "v1.11.5"), 0);
  assert.equal(compareVersions("v2.0.0", "v1.99.99"), 1);
  assert.equal(compareVersions("latest", "v1.0.0"), undefined);
  assert.equal(compareVersions("v1.0.0/../../other", "v1.0.0"), undefined);
});

test("uses a shorter retry window after a failed update", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  assert.equal(isUpdateDue({}, now, 6 * 60 * 60 * 1_000), true);
  assert.equal(
    isUpdateDue({ lastAttemptAt: "2026-08-09T11:50:00.000Z" }, now, 6 * 60 * 60 * 1_000),
    false,
  );
  assert.equal(
    isUpdateDue(
      { lastAttemptAt: "2026-08-09T11:40:00.000Z", lastError: "offline" },
      now,
      6 * 60 * 60 * 1_000,
    ),
    true,
  );
});

test("accepts regular skill entries and rejects traversal or links", () => {
  validateArchiveEntries(
    ["kimi-webbridge/", "kimi-webbridge/SKILL.md", "kimi-webbridge/references/operations.md"],
    ["drwxr-xr-x directory", "-rw-r--r-- skill", "-rw-r--r-- operations"],
  );
  assert.throws(
    () =>
      validateArchiveEntries(
        ["kimi-webbridge/", "kimi-webbridge/../outside", "kimi-webbridge/SKILL.md"],
        ["drwxr-xr-x directory", "-rw-r--r-- outside", "-rw-r--r-- skill"],
      ),
    /escapes its package root/,
  );
  assert.throws(
    () =>
      validateArchiveEntries(
        ["kimi-webbridge/", "kimi-webbridge/SKILL.md"],
        ["drwxr-xr-x directory", "lrwxr-xr-x link"],
      ),
    /unsupported entry type/,
  );
});

test("validates SKILL.md fields inside frontmatter and requires the target version", () => {
  const valid =
    '---\nname: kimi-webbridge\ndescription: |\n  Browser control.\nmetadata:\n  version: "1.2.3"\n---\n';
  assert.doesNotThrow(() => validateSkillManifest(valid, "v1.2.3"));
  assert.throws(
    () =>
      validateSkillManifest(
        '---\nmetadata:\n  version: "1.2.3"\n---\nname: kimi-webbridge\ndescription: |\n',
        "v1.2.3",
      ),
    /invalid name/,
  );
  assert.throws(() => validateSkillManifest(valid, "v1.2.4"), /version does not match/);
});

test("rejects a gzip tar whose declared expansion exceeds the skill limit", async () => {
  const oversized = gzipSync(
    Buffer.concat([tarHeader("kimi-webbridge/SKILL.md", 2_048), Buffer.alloc(1_024)]),
  );
  await assert.rejects(validateSkillArchive(oversized, 1_024), /expands beyond its safe size limit/);
});

test("stops reading a response as soon as its download limit is exceeded", async () => {
  const manager = new WebbridgeManager({
    agentDir: path.join(tmpdir(), "unused-webbridge-agent"),
    userHomeDir: path.join(tmpdir(), "unused-webbridge-home"),
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
            controller.close();
          },
        }),
      ),
  });
  await assert.rejects(manager.fetchBuffer("https://example.invalid", "Fixture", 3, 1_000), /safe size limit/);
});

test("bootstraps a verified CLI and version-matched skill into Pi cache", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-kimi-webbridge-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const userHomeDir = path.join(root, "home");
  const fixtureRoot = path.join(root, "fixture");
  const skillFixture = path.join(fixtureRoot, "kimi-webbridge");
  await mkdir(path.join(skillFixture, "references"), { recursive: true });
  await writeFile(
    path.join(skillFixture, "SKILL.md"),
    "---\nname: kimi-webbridge\ndescription: |\n  Test WebBridge skill.\nmetadata:\n  version: \"1.2.3\"\n---\n",
  );
  await writeFile(path.join(skillFixture, "references", "operations.md"), "# Operations\n");
  const archivePath = path.join(root, "skill.tar.gz");
  await runChecked("tar", ["--format=ustar", "-czf", archivePath, "-C", fixtureRoot, "kimi-webbridge"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const archive = await readFile(archivePath);

  const binary = Buffer.from(
    "#!/bin/sh\nif [ \"$1\" = status ]; then echo '{\"running\":true,\"version\":\"v1.2.3\",\"extension_connected\":true}'; fi\nexit 0\n",
  );
  const binarySha = createHash("sha256").update(binary).digest("hex");
  const binaryUrl = "https://cdn.kimi.com/webbridge/v1.2.3/releases/kimi-webbridge-darwin-arm64";
  const skillUrl = "https://cdn.kimi.com/webbridge/v1.2.3/skills/kimi-webbridge.tar.gz";
  const metadataUrl = "https://cdn.kimi.com/webbridge/latest/version.json";
  const requests = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.signal instanceof AbortSignal, true);
    assert.equal(options.signal.aborted, false);
    requests.push(url);
    if (url === metadataUrl) {
      return new Response(
        JSON.stringify({
          version: "v1.2.3",
          binaries: {
            "darwin-arm64": { url: binaryUrl, sha256: binarySha },
          },
        }),
      );
    }
    if (url === binaryUrl) return new Response(binary);
    if (url === skillUrl) return new Response(archive);
    return new Response("not found", { status: 404 });
  };

  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const officialMarker = path.join(userHomeDir, ".kimi-webbridge", "bin", "kimi-webbridge.version");
  await mkdir(path.dirname(officialMarker), { recursive: true });
  await writeFile(officialMarker, "opaque-official-state\n");
  const manager = new WebbridgeManager({
    agentDir,
    userHomeDir,
    platform: "darwin",
    arch: "arm64",
    fetchImpl,
    now: () => now,
  });
  const result = await manager.ensure();

  assert.deepEqual(result, {
    kind: "updated",
    cliUpdated: true,
    skillUpdated: true,
    version: "v1.2.3",
  });
  assert.equal(await manager.hasSkill(), true);
  assert.match(await readFile(path.join(manager.skillRoot, "SKILL.md"), "utf8"), /Test WebBridge skill/);
  assert.match(manager.skillRoot, /skills\/current$/);
  const active = JSON.parse(
    await readFile(path.join(agentDir, "cache", "pi-kimi-webbridge-bootstrap", "skills", "active.json"), "utf8"),
  );
  assert.equal(active.version, "v1.2.3");
  assert.match(active.publication, /^v1\.2\.3-[a-f0-9]{64}$/);
  assert.deepEqual(requests, [metadataUrl, binaryUrl, skillUrl]);

  const cliPath = path.join(userHomeDir, ".kimi-webbridge", "bin", "kimi-webbridge");
  assert.match(await readFile(cliPath, "utf8"), /running/);
  assert.equal(await readFile(officialMarker, "utf8"), "opaque-official-state\n");

  const state = JSON.parse(
    await readFile(path.join(agentDir, "cache", "pi-kimi-webbridge-bootstrap", "state.json"), "utf8"),
  );
  assert.equal(state.cliVersion, "v1.2.3");
  assert.equal(state.skillVersion, "v1.2.3");
  assert.equal(state.lastError, undefined);
});

test("rejects a binary whose digest does not match official metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-digest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryUrl = "https://cdn.kimi.com/webbridge/v1.2.3/releases/kimi-webbridge-darwin-arm64";
  const manager = new WebbridgeManager({
    agentDir: path.join(root, "agent"),
    userHomeDir: path.join(root, "home"),
    platform: "darwin",
    arch: "arm64",
    fetchImpl: async (url) => {
      if (url.endsWith("version.json")) {
        return new Response(
          JSON.stringify({
            version: "v1.2.3",
            binaries: {
              "darwin-arm64": { url: binaryUrl, sha256: "0".repeat(64) },
            },
          }),
        );
      }
      return new Response("unexpected binary");
    },
  });

  await assert.rejects(manager.ensure(), /SHA-256 mismatch/);
  assert.equal(await manager.hasSkill(), false);
});

test("repairs an existing CLI that cannot report status or start", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-repair-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const userHomeDir = path.join(root, "home");
  const manager = new WebbridgeManager({
    agentDir,
    userHomeDir,
    platform: "darwin",
    arch: "arm64",
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("version.json")) {
        return new Response(
          JSON.stringify({
            version: "v1.2.3",
            binaries: { "darwin-arm64": { url: binaryUrl, sha256: binarySha } },
          }),
        );
      }
      if (url === binaryUrl) return new Response(binary);
      return new Response("not found", { status: 404 });
    },
  });
  const binary = Buffer.from(
    '#!/bin/sh\nif [ "$1" = status ]; then echo \'{"running":true,"version":"v1.2.3"}\'; fi\nexit 0\n',
  );
  const binarySha = createHash("sha256").update(binary).digest("hex");
  const binaryUrl = "https://cdn.kimi.com/webbridge/v1.2.3/releases/kimi-webbridge-darwin-arm64";
  const requests = [];

  await mkdir(path.dirname(manager.cliPath), { recursive: true });
  await writeFile(manager.cliPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await mkdir(manager.legacySkillRoot, { recursive: true });
  await writeFile(
    path.join(manager.legacySkillRoot, "SKILL.md"),
    '---\nname: kimi-webbridge\ndescription: |\n  Cached skill.\nmetadata:\n  version: "1.2.3"\n---\n',
  );
  await mkdir(path.dirname(manager.statePath), { recursive: true });
  await writeFile(
    manager.statePath,
    `${JSON.stringify({ cliVersion: "v1.2.3", skillVersion: "v1.2.3" })}\n`,
  );

  assert.deepEqual(await manager.ensure(), {
    kind: "updated",
    cliUpdated: true,
    skillUpdated: false,
    version: "v1.2.3",
  });
  assert.deepEqual(requests, ["https://cdn.kimi.com/webbridge/latest/version.json", binaryUrl]);
  assert.match(await readFile(manager.cliPath, "utf8"), /running/);
});

test("restores the previous CLI when a verified replacement cannot start", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-binary-rollback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const replacement = Buffer.from("#!/bin/sh\nexit 1\n");
  const manager = new WebbridgeManager({
    agentDir: path.join(root, "agent"),
    userHomeDir: path.join(root, "home"),
    platform: "darwin",
    arch: "arm64",
    fetchImpl: async () => new Response(replacement),
  });
  const previous = "#!/bin/sh\necho previous\nexit 0\n";
  await mkdir(path.dirname(manager.cliPath), { recursive: true });
  await writeFile(manager.cliPath, previous, { mode: 0o755 });

  await assert.rejects(
    manager.installBinaryAndStart({
      binary: {
        url: "https://cdn.kimi.com/webbridge/replacement",
        sha256: createHash("sha256").update(replacement).digest("hex"),
      },
    }),
    /start failed/,
  );
  assert.equal(await readFile(manager.cliPath, "utf8"), previous);
});

test("does not reclaim a stale-looking lock while its owner process is alive", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-live-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  const second = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  const lock = await first.acquireLock(false);
  const old = new Date(Date.now() - 11 * 60 * 1_000);
  await utimes(first.lockPath, old, old);

  assert.equal(await second.acquireLock(false), undefined);
  await lock.release();
});

test("different agent directories share the user-level CLI update lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-shared-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHomeDir = path.join(root, "home");
  const first = new WebbridgeManager({ agentDir: path.join(root, "agent-a"), userHomeDir });
  const second = new WebbridgeManager({ agentDir: path.join(root, "agent-b"), userHomeDir });
  const lock = await first.acquireLock(false);

  assert.ok(lock);
  assert.equal(first.lockPath, second.lockPath);
  assert.equal(await second.acquireLock(false), undefined);
  await lock.release();
});

test("an old lock handle cannot delete a lock acquired by a new owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-lock-owner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  const contender = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  const oldOwnerName = "owner-00000000-0000-4000-8000-000000000000.json";
  await mkdir(manager.lockPath, { recursive: true });
  await writeFile(path.join(manager.lockPath, oldOwnerName), '{"pid":99999999}\n');
  const old = new Date(Date.now() - 11 * 60 * 1_000);
  await utimes(manager.lockPath, old, old);

  const currentLock = await manager.acquireLock(false);
  assert.ok(currentLock);
  await manager.releaseLock(oldOwnerName);
  assert.equal(await contender.acquireLock(false), undefined);
  await currentLock.release();
});

test("publishes a skill through an atomic pointer while preserving the legacy fallback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-skill-publish-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  const candidate = path.join(root, "candidate");
  const manifest =
    '---\nname: kimi-webbridge\ndescription: |\n  Browser control.\nmetadata:\n  version: "1.2.3"\n---\n';
  await mkdir(manager.legacySkillRoot, { recursive: true });
  await writeFile(path.join(manager.legacySkillRoot, "SKILL.md"), "legacy\n");
  await mkdir(candidate, { recursive: true });
  await writeFile(path.join(candidate, "SKILL.md"), manifest);

  await manager.publishSkill(candidate, "v1.2.3", "a".repeat(64));
  assert.equal(manager.skillRoot, manager.currentSkillRoot);
  assert.equal(await readFile(path.join(manager.currentSkillRoot, "SKILL.md"), "utf8"), manifest);
  assert.equal(await readFile(path.join(manager.legacySkillRoot, "SKILL.md"), "utf8"), "legacy\n");
  assert.equal(await manager.hasSkill(), true);
  const firstActive = JSON.parse(await readFile(manager.activeSkillPath, "utf8"));
  const nextCandidate = path.join(root, "next-candidate");
  const nextManifest = manifest.replace(/1\.2\.3/g, "1.2.4");
  await mkdir(nextCandidate, { recursive: true });
  await writeFile(path.join(nextCandidate, "SKILL.md"), nextManifest);
  await manager.publishSkill(nextCandidate, "v1.2.4", "b".repeat(64));
  assert.equal(manager.skillRoot, manager.currentSkillRoot);
  assert.equal(await readFile(path.join(manager.currentSkillRoot, "SKILL.md"), "utf8"), nextManifest);
  assert.equal(
    await readFile(path.join(manager.skillReleasesRoot, firstActive.publication, "SKILL.md"), "utf8"),
    manifest,
  );

  const active = JSON.parse(await readFile(manager.activeSkillPath, "utf8"));
  await unlink(manager.currentSkillRoot);
  await rm(path.join(manager.skillReleasesRoot, active.publication), { recursive: true, force: true });
  assert.equal(await manager.hasSkill(), true);
  assert.equal(manager.skillRoot, manager.currentSkillRoot);
  assert.equal(await readFile(path.join(manager.currentSkillRoot, "SKILL.md"), "utf8"), "legacy\n");
});

test("keeps a cached legacy skill usable when stable-path activation fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-skill-fallback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  await mkdir(manager.legacySkillRoot, { recursive: true });
  await writeFile(path.join(manager.legacySkillRoot, "SKILL.md"), "legacy\n");
  manager.activateSkillRoot = async () => {
    throw new Error("symlink unavailable");
  };

  assert.equal(await manager.hasSkill(), true);
  assert.equal(manager.skillRoot, manager.legacySkillRoot);
});

test("does not trust a pre-existing release directory with the expected name", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-skill-collision-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({ agentDir: root, userHomeDir: root });
  const digest = "c".repeat(64);
  const publication = `v1.2.3-${digest}`;
  const manifest =
    '---\nname: kimi-webbridge\ndescription: |\n  Browser control.\nmetadata:\n  version: "1.2.3"\n---\n';
  const existing = path.join(manager.skillReleasesRoot, publication);
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "SKILL.md"), manifest);

  const candidate = path.join(root, "candidate");
  await mkdir(path.join(candidate, "references"), { recursive: true });
  await writeFile(path.join(candidate, "SKILL.md"), manifest);
  await writeFile(path.join(candidate, "references", "operations.md"), "complete\n");
  await manager.publishSkill(candidate, "v1.2.3", digest);

  const active = JSON.parse(await readFile(manager.activeSkillPath, "utf8"));
  assert.notEqual(active.publication, publication);
  assert.match(active.publication, new RegExp(`^${publication}-[0-9a-f-]{36}$`));
  assert.equal(
    await readFile(path.join(manager.currentSkillRoot, "references", "operations.md"), "utf8"),
    "complete\n",
  );
});

test("Windows selects immutable skill releases through the atomic pointer", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-windows-pointer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({
    agentDir: path.join(root, "agent"),
    userHomeDir: path.join(root, "home"),
    platform: "win32",
    arch: "x64",
  });
  const manifest = (version) =>
    `---\nname: kimi-webbridge\ndescription: |\n  Browser control.\nmetadata:\n  version: "${version}"\n---\n`;

  for (const [version, digest] of [
    ["v1.2.3", "d".repeat(64)],
    ["v1.2.4", "e".repeat(64)],
  ]) {
    const candidate = path.join(root, `candidate-${version}`);
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "SKILL.md"), manifest(version.slice(1)));
    await manager.publishSkill(candidate, version, digest);
  }

  const active = JSON.parse(await readFile(manager.activeSkillPath, "utf8"));
  assert.equal(active.version, "v1.2.4");
  assert.match(manager.skillRoot, /skills\/releases\/v1\.2\.4-/);
  assert.equal(await manager.hasSkill(), true);
  assert.match(await readFile(path.join(manager.skillRoot, "SKILL.md"), "utf8"), /1\.2\.4/);
  await assert.rejects(readFile(path.join(manager.currentSkillRoot, "SKILL.md"), "utf8"), /ENOENT/);
});

test("reinstalls a cached skill when its manifest version differs from the daemon", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-webbridge-skill-version-repair-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new WebbridgeManager({
    agentDir: path.join(root, "agent"),
    userHomeDir: path.join(root, "home"),
    platform: "darwin",
    arch: "arm64",
  });
  await mkdir(path.dirname(manager.cliPath), { recursive: true });
  await writeFile(
    manager.cliPath,
    '#!/bin/sh\nif [ "$1" = status ]; then echo \'{"running":true,"version":"v1.2.3"}\'; fi\nexit 0\n',
    { mode: 0o755 },
  );
  await mkdir(manager.legacySkillRoot, { recursive: true });
  await writeFile(
    path.join(manager.legacySkillRoot, "SKILL.md"),
    '---\nname: kimi-webbridge\ndescription: |\n  Old skill.\nmetadata:\n  version: "1.2.2"\n---\n',
  );
  await mkdir(path.dirname(manager.statePath), { recursive: true });
  await writeFile(
    manager.statePath,
    `${JSON.stringify({
      lastAttemptAt: new Date().toISOString(),
      cliVersion: "v1.2.3",
      skillVersion: "v1.2.3",
    })}\n`,
  );
  manager.fetchMetadata = async () => ({
    version: "v1.2.3",
    binary: { url: "https://cdn.kimi.com/webbridge/unused", sha256: "f".repeat(64) },
  });
  let installedVersion;
  manager.installSkill = async (version) => {
    installedVersion = version;
  };

  const result = await manager.ensure();
  assert.equal(result.skillUpdated, true);
  assert.equal(installedVersion, "v1.2.3");
});
