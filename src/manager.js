import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { parse as parseYaml } from "yaml";

import { runChecked, runCommand } from "./process.js";

export const DEFAULT_CDN_BASE = "https://cdn.kimi.com/webbridge";
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const FAILURE_RETRY_MS = 15 * 60 * 1_000;
const LOCK_STALE_MS = 10 * 60 * 1_000;
const LOCK_WAIT_MS = 30_000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_SKILL_ENTRIES = 2_048;
const DAEMON_READY_WAIT_MS = 8_000;
const METADATA_DOWNLOAD_TIMEOUT_MS = 20_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 180_000;
const SKILL_DOWNLOAD_TIMEOUT_MS = 60_000;

function normalizeVersion(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function parseReleaseVersion(value) {
  const normalized = normalizeVersion(value);
  if (normalized === undefined || normalized.length > 64) return undefined;
  const match =
    /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      normalized,
    );
  if (match === null) return undefined;
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return undefined;
  return { normalized, numbers };
}

function isReleaseVersion(value) {
  return parseReleaseVersion(value) !== undefined;
}

export function compareVersions(left, right) {
  const a = parseReleaseVersion(left)?.numbers;
  const b = parseReleaseVersion(right)?.numbers;
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const normalizedArch = arch === "x64" ? "amd64" : arch;
  if ((platform === "darwin" || platform === "linux") && ["arm64", "amd64"].includes(normalizedArch)) {
    return `${platform}-${normalizedArch}`;
  }
  if (platform === "win32" && normalizedArch === "amd64") return "windows-amd64";
  return undefined;
}

export function isUpdateDue(state, now, intervalMs = DEFAULT_INTERVAL_MS) {
  if (typeof state.lastAttemptAt !== "string") return true;
  const lastAttempt = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(lastAttempt)) return true;
  const retryMs = state.lastError === undefined ? intervalMs : Math.min(intervalMs, FAILURE_RETRY_MS);
  return now - lastAttempt >= retryMs;
}

export function validateArchiveEntries(names, verboseLines) {
  if (names.length === 0 || names.length !== verboseLines.length) {
    throw new Error("WebBridge skill archive has an invalid entry listing");
  }

  let hasSkill = false;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const entryType = verboseLines[index]?.[0];
    if (entryType !== "-" && entryType !== "d") {
      throw new Error(`WebBridge skill archive contains unsupported entry type: ${name}`);
    }
    if (name.includes("\\") || name.startsWith("/") || name.includes("\0")) {
      throw new Error(`WebBridge skill archive contains unsafe path: ${name}`);
    }
    const withoutTrailingSlash = name.replace(/\/+$/, "");
    const segments = withoutTrailingSlash.split("/");
    if (
      segments[0] !== "kimi-webbridge" ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`WebBridge skill archive escapes its package root: ${name}`);
    }
    if (withoutTrailingSlash === "kimi-webbridge/SKILL.md") hasSkill = true;
  }
  if (!hasSkill) throw new Error("WebBridge skill archive does not contain kimi-webbridge/SKILL.md");
}

function tarFieldString(field) {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8").trimEnd();
}

function parseTarOctal(field, label) {
  if ((field[0] & 0x80) !== 0) {
    throw new Error(`WebBridge skill archive uses an unsupported ${label} encoding`);
  }
  const raw = tarFieldString(field).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`WebBridge skill archive has an invalid ${label}`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`WebBridge skill archive has an invalid ${label}`);
  }
  return value;
}

function verifyTarChecksum(header) {
  const expected = parseTarOctal(header.subarray(148, 156), "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error("WebBridge skill archive has an invalid header checksum");
  }
}

export async function validateSkillArchive(
  archive,
  maxExpandedBytes = MAX_SKILL_EXPANDED_BYTES,
  maxEntries = MAX_SKILL_ENTRIES,
) {
  const gunzip = createGunzip();
  const entries = [];
  let buffered = Buffer.alloc(0);
  let entryRemaining = 0;
  let entryPadding = 0;
  let expandedBytes = 0;
  let declaredFileBytes = 0;
  let zeroBlocks = 0;
  let ended = false;
  const maxTarBytes = maxExpandedBytes + (maxEntries * 2 + 2) * 512;

  gunzip.end(archive);
  try {
    for await (const value of gunzip) {
      const chunk = Buffer.from(value);
      expandedBytes += chunk.length;
      if (expandedBytes > maxTarBytes) {
        throw new Error("WebBridge skill archive expands beyond its safe size limit");
      }
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);

      while (buffered.length > 0) {
        if (ended) {
          if (buffered.some((byte) => byte !== 0)) {
            throw new Error("WebBridge skill archive has data after its end marker");
          }
          buffered = Buffer.alloc(0);
          break;
        }

        if (entryRemaining > 0) {
          const consumed = Math.min(entryRemaining, buffered.length);
          buffered = buffered.subarray(consumed);
          entryRemaining -= consumed;
          continue;
        }
        if (entryPadding > 0) {
          const consumed = Math.min(entryPadding, buffered.length);
          if (buffered.subarray(0, consumed).some((byte) => byte !== 0)) {
            throw new Error("WebBridge skill archive has invalid entry padding");
          }
          buffered = buffered.subarray(consumed);
          entryPadding -= consumed;
          continue;
        }
        if (buffered.length < 512) break;

        const header = buffered.subarray(0, 512);
        buffered = buffered.subarray(512);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks >= 2) ended = true;
          continue;
        }
        if (zeroBlocks > 0) {
          throw new Error("WebBridge skill archive has an invalid end marker");
        }

        verifyTarChecksum(header);
        const name = tarFieldString(header.subarray(0, 100));
        const prefix = tarFieldString(header.subarray(345, 500));
        const fullName = prefix.length === 0 ? name : `${prefix}/${name}`;
        const typeFlag = String.fromCharCode(header[156] || 0x30);
        const size = parseTarOctal(header.subarray(124, 136), "entry size");
        const entryType = typeFlag === "0" ? "-" : typeFlag === "5" ? "d" : typeFlag;
        if (entryType === "d" && size !== 0) {
          throw new Error(`WebBridge skill archive directory has a non-zero size: ${fullName}`);
        }
        if (entryType === "-") {
          declaredFileBytes += size;
          if (declaredFileBytes > maxExpandedBytes) {
            throw new Error("WebBridge skill archive expands beyond its safe size limit");
          }
        }
        entries.push({ name: fullName, type: entryType, size });
        if (entries.length > maxEntries) {
          throw new Error("WebBridge skill archive contains too many entries");
        }
        entryRemaining = size;
        entryPadding = (512 - (size % 512)) % 512;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WebBridge skill archive")) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`WebBridge skill archive is not a valid gzip tar: ${detail}`, { cause: error });
  } finally {
    gunzip.destroy();
  }

  if (!ended || buffered.length !== 0 || entryRemaining !== 0 || entryPadding !== 0) {
    throw new Error("WebBridge skill archive is truncated");
  }
  validateArchiveEntries(
    entries.map((entry) => entry.name),
    entries.map((entry) => entry.type),
  );
  if (new Set(entries.map((entry) => entry.name.replace(/\/+$/, ""))).size !== entries.length) {
    throw new Error("WebBridge skill archive contains duplicate entries");
  }
  return entries;
}

export function validateSkillManifest(source, expectedVersion) {
  // Pi checks for "---" before stripping a BOM, so a BOM hides the frontmatter
  // and Pi silently drops the skill. Reject it instead of publishing it.
  if (source.startsWith("\uFEFF")) throw new Error("WebBridge SKILL.md starts with a byte order mark");
  // Match Pi's boundaries: it normalizes every line ending and ends the
  // frontmatter at the first later line that merely starts with "---".
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error("WebBridge SKILL.md has no YAML frontmatter");
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.startsWith("---"));
  if (closingIndex === -1) throw new Error("WebBridge SKILL.md has unterminated YAML frontmatter");
  if (lines[closingIndex] !== "---") throw new Error("WebBridge SKILL.md has an ambiguous frontmatter delimiter");
  let frontmatter;
  try {
    // Use the same YAML semantics as Pi, including duplicate-key rejection.
    frontmatter = parseYaml(lines.slice(1, closingIndex).join("\n"));
  } catch (error) {
    throw new Error(`WebBridge SKILL.md has invalid YAML frontmatter: ${error.message}`, { cause: error });
  }
  // Unknown keys are allowed: Pi ignores them, and upstream may add optional
  // Agent Skills fields without making the skill unusable.
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("WebBridge SKILL.md has invalid frontmatter");
  }
  if (frontmatter.name !== "kimi-webbridge") {
    throw new Error("WebBridge SKILL.md has an invalid name");
  }
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
    throw new Error("WebBridge SKILL.md has an invalid description");
  }
  const metadata = frontmatter.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("WebBridge SKILL.md has invalid metadata");
  }
  const actual = parseReleaseVersion(metadata.version)?.normalized;
  if (actual === undefined) {
    throw new Error("WebBridge SKILL.md has an invalid metadata version");
  }
  if (expectedVersion !== undefined && actual !== parseReleaseVersion(expectedVersion)?.normalized) {
    throw new Error(`WebBridge SKILL.md version does not match ${expectedVersion}`);
  }
  return actual;
}

function parseIntervalMs(env) {
  const raw = env.PI_WEBBRIDGE_UPDATE_INTERVAL_HOURS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1_000 : DEFAULT_INTERVAL_MS;
}

async function exists(filePath) {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

async function readJson(filePath, fallback = {}) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

async function writeAtomic(filePath, contents, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function responseBuffer(response, label, maxBytes) {
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new Error(`${label} download exceeds its safe size limit`);
  }
  if (response.body === null) throw new Error(`${label} download has invalid size: 0 bytes`);

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} download exceeds its safe size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new Error(`${label} download has invalid size: 0 bytes`);
  return Buffer.concat(chunks, totalBytes);
}

function validateMetadata(value, key) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WebBridge version metadata is not an object");
  }
  const version = normalizeVersion(value.version);
  const binary = value.binaries?.[key];
  if (
    version === undefined ||
    !isReleaseVersion(version) ||
    binary === null ||
    typeof binary !== "object" ||
    typeof binary.url !== "string" ||
    !binary.url.startsWith("https://cdn.kimi.com/webbridge/") ||
    typeof binary.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(binary.sha256)
  ) {
    throw new Error(`WebBridge version metadata has no trusted binary for ${key}`);
  }
  return { version, binary: { url: binary.url, sha256: binary.sha256 } };
}

function updateAvailable(status, localVersion, latestVersion) {
  if (status?.version_mismatch) return true;
  if (status?.update_available === true) return true;
  return compareVersions(localVersion, latestVersion) === -1;
}

function summarizeState(state) {
  return {
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessfulAt: state.lastSuccessfulAt,
    cliVersion: state.cliVersion,
    skillVersion: state.skillVersion,
    lastError: state.lastError,
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export class WebbridgeManager {
  constructor(options) {
    this.agentDir = options.agentDir;
    this.userHomeDir = options.userHomeDir ?? homedir();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runImpl = options.runImpl ?? runCommand;
    this.runCheckedImpl = options.runCheckedImpl ?? runChecked;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.cdnBase = options.cdnBase ?? DEFAULT_CDN_BASE;
    this.intervalMs = options.intervalMs ?? parseIntervalMs(this.env);

    this.stateRoot = path.join(this.agentDir, "cache", "pi-kimi-webbridge-bootstrap");
    this.skillsRoot = path.join(this.stateRoot, "skills");
    this.legacySkillRoot = path.join(this.skillsRoot, "kimi-webbridge");
    this.skillReleasesRoot = path.join(this.skillsRoot, "releases");
    this.currentSkillRoot = path.join(this.skillsRoot, "current");
    this.activeSkillPath = path.join(this.skillsRoot, "active.json");
    this.skillRoot = this.legacySkillRoot;
    this.statePath = path.join(this.stateRoot, "state.json");
    this.cliPath = path.join(
      this.userHomeDir,
      ".kimi-webbridge",
      "bin",
      this.platform === "win32" ? "kimi-webbridge.exe" : "kimi-webbridge",
    );
    // The daemon and CLI are shared by every Pi agent directory for this user,
    // so their update lock must live beside that shared runtime as well.
    this.lockPath = path.join(path.dirname(path.dirname(this.cliPath)), "pi-bootstrap-update.lock");
  }

  autoUpdateEnabled() {
    return this.env.PI_WEBBRIDGE_AUTO_UPDATE !== "0";
  }

  async hasSkill() {
    return (await this.resolveSkillRoot()) !== undefined;
  }

  async resolveSkillRoot() {
    if (this.platform !== "win32" && (await exists(path.join(this.currentSkillRoot, "SKILL.md")))) {
      this.skillRoot = this.currentSkillRoot;
      return this.currentSkillRoot;
    }
    const pointer = await readJson(this.activeSkillPath);
    const publication = pointer.publication;
    if (
      typeof publication === "string" &&
      publication.length <= 220 &&
      /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(publication) &&
      !publication.includes("..")
    ) {
      const candidate = path.join(this.skillReleasesRoot, publication);
      if (await exists(path.join(candidate, "SKILL.md"))) {
        if (this.platform === "win32") {
          this.skillRoot = candidate;
          return candidate;
        }
        try {
          await this.activateSkillRoot(candidate);
          return this.skillRoot;
        } catch {
          // A cached release is still usable when migration to the stable
          // resource path fails (for example because the filesystem refuses a
          // symlink). Do not let cache housekeeping block Pi startup.
          this.skillRoot = candidate;
          return candidate;
        }
      }
    }
    if (await exists(path.join(this.legacySkillRoot, "SKILL.md"))) {
      if (this.platform === "win32") {
        this.skillRoot = this.legacySkillRoot;
        return this.legacySkillRoot;
      }
      try {
        await this.activateSkillRoot(this.legacySkillRoot);
        return this.skillRoot;
      } catch {
        this.skillRoot = this.legacySkillRoot;
        return this.legacySkillRoot;
      }
    }
    return undefined;
  }

  async readSkillPublication() {
    const skillRoot = await this.resolveSkillRoot();
    if (skillRoot === undefined) return undefined;
    // Resolve the stable symlink to its immutable release, including same-version refreshes.
    return realpath(skillRoot).catch(() => undefined);
  }

  async readInstalledSkillVersion() {
    const skillRoot = await this.resolveSkillRoot();
    if (skillRoot === undefined) return undefined;
    try {
      const source = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
      return validateSkillManifest(source);
    } catch {
      return undefined;
    }
  }

  async inspect() {
    const [state, cliInstalled, skillRoot] = await Promise.all([
      readJson(this.statePath),
      exists(this.cliPath),
      this.resolveSkillRoot(),
    ]);
    const daemon = cliInstalled ? await this.readDaemonStatus() : undefined;
    return {
      cliInstalled,
      skillInstalled: skillRoot !== undefined,
      cliPath: this.cliPath,
      skillRoot: skillRoot ?? this.skillRoot,
      daemon,
      state: summarizeState(state),
    };
  }

  async ensure(options = {}) {
    const force = options.force === true;
    const hasCachedSkill = await this.hasSkill();
    const lock = await this.acquireLock(force || !hasCachedSkill);
    if (!lock) return { kind: "busy", cliUpdated: false, skillUpdated: false };

    let state = await readJson(this.statePath);
    let committedResult;
    try {
      const cliInstalledBefore = await exists(this.cliPath);
      let daemon;
      let cliNeedsRepair = false;
      if (cliInstalledBefore) {
        try {
          daemon = await this.readDaemonStatus();
          if (daemon?.running === true && !isReleaseVersion(daemon.version)) {
            cliNeedsRepair = true;
          } else if (daemon?.running !== true) {
            await this.runCliChecked(["start"], 30_000);
            daemon = await this.waitForDaemonReady();
          }
        } catch {
          cliNeedsRepair = true;
          daemon = undefined;
        }
      }
      const daemonVersionBefore = parseReleaseVersion(daemon?.version)?.normalized;
      const cachedSkillVersion = hasCachedSkill ? await this.readInstalledSkillVersion() : undefined;
      const skillNeedsRepair =
        hasCachedSkill && daemonVersionBefore !== undefined && cachedSkillVersion !== daemonVersionBefore;

      const due =
        force ||
        !hasCachedSkill ||
        !cliInstalledBefore ||
        cliNeedsRepair ||
        skillNeedsRepair ||
        isUpdateDue(state, this.now(), this.intervalMs);
      if (!due) {
        if (cachedSkillVersion !== undefined && state.skillVersion !== cachedSkillVersion) {
          state = { ...state, skillVersion: cachedSkillVersion };
          await this.writeState(state);
        }
        return {
          kind: "ready",
          cliUpdated: false,
          skillUpdated: false,
          version: normalizeVersion(daemon?.version) ?? state.cliVersion,
        };
      }

      state = { ...state, lastAttemptAt: new Date(this.now()).toISOString() };
      await this.writeState(state);

      const key = platformKey(this.platform, this.arch);
      if (key === undefined) throw new Error(`Unsupported platform: ${this.platform}/${this.arch}`);
      const metadata = await this.fetchMetadata(key);

      let cliUpdated = false;
      if (!cliInstalledBefore || cliNeedsRepair) {
        daemon = await this.installBinaryAndStart(metadata);
        cliUpdated = true;
      } else {
        const localVersion = parseReleaseVersion(daemon?.version)?.normalized;
        if (updateAvailable(daemon, localVersion, metadata.version)) {
          const versionWasBehind = compareVersions(localVersion, metadata.version) === -1;
          await this.runCliChecked(["upgrade"], 180_000);
          daemon = await this.waitForDaemonReady();
          if (versionWasBehind && compareVersions(daemon.version, metadata.version) === -1) {
            throw new Error("kimi-webbridge upgrade did not activate the downloaded version");
          }
          cliUpdated = true;
        }
      }

      const targetVersion = parseReleaseVersion(daemon?.version)?.normalized;
      if (targetVersion === undefined) {
        throw new Error("Kimi WebBridge daemon returned an invalid version");
      }
      const skillUpdated = force || !hasCachedSkill || cachedSkillVersion !== targetVersion;
      const warnings = skillUpdated ? (await this.installSkill(targetVersion)) ?? [] : [];
      const result = {
        kind: cliUpdated || skillUpdated ? "updated" : "ready",
        cliUpdated,
        skillUpdated,
        version: targetVersion,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      // Once the active pointer has changed, bookkeeping/cleanup errors must
      // not turn a committed publication into a failed update and lose reload.
      if (skillUpdated) committedResult = result;

      state = {
        ...state,
        lastSuccessfulAt: new Date(this.now()).toISOString(),
        cliVersion: targetVersion,
        skillVersion: targetVersion,
      };
      delete state.lastError;
      await this.writeState(state);

      return result;
    } catch (error) {
      state = {
        ...state,
        lastAttemptAt: state.lastAttemptAt ?? new Date(this.now()).toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      await this.writeState(state).catch(() => undefined);
      if (committedResult) {
        (committedResult.warnings ??= []).push(`Skill is active, but update bookkeeping failed: ${state.lastError}`);
        return committedResult;
      }
      throw error;
    } finally {
      try {
        await lock.release();
      } catch (error) {
        if (!committedResult) throw error;
        (committedResult.warnings ??= []).push(
          `Skill is active, but releasing the update lock failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async fetchMetadata(key) {
    const buffer = await this.fetchBuffer(
      `${this.cdnBase}/latest/version.json`,
      "WebBridge metadata",
      MAX_METADATA_BYTES,
      METADATA_DOWNLOAD_TIMEOUT_MS,
    );
    let value;
    try {
      value = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      throw new Error(`WebBridge version metadata is not valid JSON: ${error.message}`);
    }
    return validateMetadata(value, key);
  }

  async installBinaryAndStart(metadata) {
    const buffer = await this.fetchBuffer(
      metadata.binary.url,
      "WebBridge binary",
      MAX_BINARY_BYTES,
      BINARY_DOWNLOAD_TIMEOUT_MS,
    );
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== metadata.binary.sha256) {
      throw new Error(`WebBridge binary SHA-256 mismatch: expected ${metadata.binary.sha256}, got ${digest}`);
    }

    await mkdir(path.dirname(this.cliPath), { recursive: true });
    const temporary = `${this.cliPath}.${process.pid}.${Date.now()}.tmp`;
    const previous = `${this.cliPath}.rollback-${process.pid}-${Date.now()}`;
    let hasPrevious = false;
    let preservePrevious = false;
    try {
      await writeFile(temporary, buffer, { mode: 0o755 });
      if (this.platform !== "win32") await chmod(temporary, 0o755);
      if (await exists(this.cliPath)) {
        await copyFile(this.cliPath, previous);
        if (this.platform !== "win32") await chmod(previous, 0o755);
        hasPrevious = true;
      }
      await rename(temporary, this.cliPath);

      try {
        await this.runCliChecked(["start"], 30_000);
        const daemon = await this.waitForDaemonReady();
        if (hasPrevious) {
          await rm(previous, { force: true }).catch(() => undefined);
          hasPrevious = false;
        }
        return daemon;
      } catch (error) {
        try {
          if (hasPrevious) {
            await rename(previous, this.cliPath);
            hasPrevious = false;
          } else {
            await rm(this.cliPath, { force: true });
          }
        } catch (rollbackError) {
          preservePrevious = true;
          throw new AggregateError(
            [error, rollbackError],
            `Kimi WebBridge binary activation failed and rollback failed; backup remains at ${previous}`,
          );
        }
        throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (hasPrevious && !preservePrevious && (await exists(this.cliPath))) {
        await rm(previous, { force: true }).catch(() => undefined);
      }
    }
  }

  async installSkill(version) {
    const parsedVersion = parseReleaseVersion(version);
    if (parsedVersion === undefined) throw new Error(`Invalid WebBridge skill version: ${version}`);
    version = parsedVersion.normalized;
    const url = `${this.cdnBase}/${version}/skills/${
      this.platform === "win32" ? "kimi-webbridge-windows.tar.gz" : "kimi-webbridge.tar.gz"
    }`;
    const archive = await this.fetchBuffer(
      url,
      "WebBridge skill",
      MAX_SKILL_BYTES,
      SKILL_DOWNLOAD_TIMEOUT_MS,
    );
    await validateSkillArchive(archive);
    const archiveDigest = createHash("sha256").update(archive).digest("hex");

    await mkdir(this.stateRoot, { recursive: true });
    const workRoot = await mkdtemp(path.join(this.stateRoot, ".skill-update-"));
    const archivePath = path.join(workRoot, "skill.tar.gz");
    const extractRoot = path.join(workRoot, "extract");
    await mkdir(extractRoot);
    try {
      await writeFile(archivePath, archive, { mode: 0o600 });
      await this.runCheckedImpl("tar", ["-xzf", archivePath, "-C", extractRoot], {
        timeoutMs: 30_000,
      });

      const candidate = path.join(extractRoot, "kimi-webbridge");
      const skill = await readFile(path.join(candidate, "SKILL.md"), "utf8");
      validateSkillManifest(skill, version);
      return await this.publishSkill(candidate, version, archiveDigest);
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async publishSkill(candidate, version, archiveDigest) {
    await mkdir(this.skillReleasesRoot, { recursive: true });
    const basePublication = `${version}-${archiveDigest}`;
    let publication = basePublication;
    let target = path.join(this.skillReleasesRoot, publication);
    try {
      await rename(candidate, target);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      // Release directories are immutable publications. If the expected name
      // already exists, do not trust a partial comparison of local contents;
      // publish the fully validated candidate under a unique name instead.
      publication = `${basePublication}-${randomUUID()}`;
      target = path.join(this.skillReleasesRoot, publication);
      await rename(candidate, target);
    }

    const pointer = `${JSON.stringify(
      { publication, version, sha256: archiveDigest, publishedAt: new Date(this.now()).toISOString() },
      null,
      2,
    )}\n`;
    if (this.platform === "win32") {
      // Windows cannot atomically rename a new junction over an existing one.
      // active.json is the atomic selector there; resource discovery resolves
      // it to the immutable publication after a reload.
      await writeAtomic(this.activeSkillPath, pointer);
      this.skillRoot = target;
      return [];
    }
    // On POSIX, current is the authoritative selector and its atomic rename is
    // the commit point. active.json is only a recovery hint; writing it before
    // activation could expose an uncommitted release to concurrent readers.
    await this.activateSkillRoot(target);
    try {
      await writeAtomic(this.activeSkillPath, pointer);
      return [];
    } catch (error) {
      return [`Skill is active, but writing active.json failed: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  async activateSkillRoot(target) {
    await mkdir(this.skillsRoot, { recursive: true });
    const temporary = `${this.currentSkillRoot}.${process.pid}.${randomUUID()}.tmp`;
    const linkTarget = this.platform === "win32" ? target : path.relative(this.skillsRoot, target);
    try {
      await symlink(linkTarget, temporary, this.platform === "win32" ? "junction" : "dir");
      await rename(temporary, this.currentSkillRoot);
      this.skillRoot = this.currentSkillRoot;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async readDaemonStatus() {
    let result;
    try {
      result = await this.runImpl(this.cliPath, ["status"], { timeoutMs: 10_000 });
    } catch {
      return undefined;
    }
    if (result.code !== 0 || result.timedOut) return undefined;
    try {
      const value = JSON.parse(result.stdout);
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async fetchBuffer(url, label, maxBytes, timeoutMs) {
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      return await responseBuffer(response, label, maxBytes);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${label} download`)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} download failed: ${detail}`, { cause: error });
    }
  }

  async waitForDaemonReady() {
    const deadline = Date.now() + DAEMON_READY_WAIT_MS;
    let status;
    do {
      status = await this.readDaemonStatus();
      if (status?.running === true && isReleaseVersion(status.version)) return status;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (true);

    const detail =
      status?.running === true && !isReleaseVersion(status.version)
        ? ": invalid daemon version"
        : typeof status?.note === "string"
          ? `: ${status.note}`
          : "";
    throw new Error(`Kimi WebBridge daemon did not become ready${detail}`);
  }

  async runCliChecked(args, timeoutMs) {
    const result = await this.runImpl(this.cliPath, args, { timeoutMs });
    if (result.code === 0 && !result.timedOut) return result;
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`kimi-webbridge ${args.join(" ")} failed: ${result.timedOut ? "timed out" : detail}`);
  }

  async writeState(state) {
    await writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  async releaseLock(ownerName) {
    try {
      await unlink(path.join(this.lockPath, ownerName));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    try {
      await rmdir(this.lockPath);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    }
  }

  async reclaimStaleLock() {
    let names;
    try {
      names = await readdir(this.lockPath);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
    const ownerNames = names.filter(
      (name) => name === "owner.json" || /^owner-[0-9a-f-]{36}\.json$/.test(name),
    );
    if (ownerNames.length !== names.length) return false;

    for (const ownerName of ownerNames) {
      const owner = await readJson(path.join(this.lockPath, ownerName));
      if (isProcessAlive(owner.pid)) return false;
    }
    for (const ownerName of ownerNames) {
      try {
        await unlink(path.join(this.lockPath, ownerName));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try {
      await rmdir(this.lockPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
      throw error;
    }
  }

  async acquireLock(wait) {
    await Promise.all([
      mkdir(this.stateRoot, { recursive: true }),
      mkdir(path.dirname(this.lockPath), { recursive: true }),
    ]);
    const deadline = this.now() + (wait ? LOCK_WAIT_MS : 0);
    while (true) {
      let acquired = false;
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }

      if (acquired) {
        const ownerName = `owner-${randomUUID()}.json`;
        try {
          await writeFile(
            path.join(this.lockPath, ownerName),
            `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(this.now()).toISOString() })}\n`,
            { mode: 0o600 },
          );
          return { release: () => this.releaseLock(ownerName) };
        } catch (error) {
          await this.releaseLock(ownerName).catch(() => undefined);
          if (error.code === "ENOENT") continue;
          throw error;
        }
      }

      const lockStat = await stat(this.lockPath).catch(() => undefined);
      if (lockStat !== undefined && this.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        if (await this.reclaimStaleLock()) continue;
      }
      if (!wait || this.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
