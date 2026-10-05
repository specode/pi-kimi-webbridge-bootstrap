import assert from "node:assert/strict";
import test from "node:test";
import { registerWebbridgeBootstrap } from "../extensions/kimi-webbridge-bootstrap.js";

function setup(managerOverrides = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  registerWebbridgeBootstrap({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
  }, {
    autoUpdateEnabled: () => true,
    hasSkill: async () => true,
    readSkillPublication: async () => "release-a",
    ensure: () => pending,
    ...managerOverrides,
  });
  const ctx = { hasUI: true, ui: { notify: (message) => notifications.push(message) } };
  return { handlers, commands, notifications, ctx, finish };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 4_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), "background recovery did not complete");
}

test("reload during an update lets the new runtime detect the completed publication", async (t) => {
  let publication = "release-a";
  let locked = true;
  let attempts = 0;
  const readSkillPublication = async () => publication;
  const old = setup({ readSkillPublication });
  await old.handlers.get("session_start")({ reason: "startup" }, old.ctx);
  old.handlers.get("session_shutdown")({ reason: "reload" });
  Object.defineProperty(old.ctx, "ui", { get() { throw new Error("stale UI"); } });
  Object.defineProperty(old.ctx, "hasUI", { get() { throw new Error("stale UI"); } });

  const current = setup({
    readSkillPublication,
    ensure: async ({ force }) => {
      assert.equal(force, false);
      attempts += 1;
      return { kind: locked ? "busy" : "ready", skillUpdated: false };
    },
  });
  t.after(() => current.handlers.get("session_shutdown")({ reason: "exit" }));
  await current.handlers.get("session_start")({ reason: "reload" }, current.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.deepEqual(current.notifications, []);

  publication = "release-b";
  locked = false;
  old.finish({ kind: "updated", skillUpdated: true });
  await waitFor(() => current.notifications.length > 0);
  assert.equal(attempts, 2);
  assert.equal(current.notifications.length, 1);
  assert.match(current.notifications[0], /Run \/reload/);
  assert.deepEqual(old.notifications, []);
});

test("a busy check that leaves the publication unchanged does not request reload", async (t) => {
  let attempts = 0;
  const current = setup({
    ensure: async () => ({ kind: ++attempts === 1 ? "busy" : "ready", skillUpdated: false }),
  });
  t.after(() => current.handlers.get("session_shutdown")({ reason: "exit" }));
  await current.handlers.get("session_start")({ reason: "reload" }, current.ctx);
  await waitFor(() => attempts === 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(current.notifications, []);
});

test("publication changes are detected even if the old updater releases its lock before our check", async () => {
  let publication = "release-a";
  const current = setup({
    readSkillPublication: async () => publication,
    ensure: async () => {
      publication = "release-b";
      return { kind: "ready", skillUpdated: false };
    },
  });
  await current.handlers.get("session_start")({ reason: "reload" }, current.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.notifications.length, 1);
});

test("shutdown cancels cached busy recovery without another update or stale notification", async () => {
  let attempts = 0;
  const current = setup({
    ensure: async () => {
      attempts += 1;
      return { kind: "busy", skillUpdated: false };
    },
  });
  await current.handlers.get("session_start")({ reason: "reload" }, current.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  current.handlers.get("session_shutdown")({ reason: "reload" });
  Object.defineProperty(current.ctx, "ui", { get() { throw new Error("stale UI"); } });
  Object.defineProperty(current.ctx, "hasUI", { get() { throw new Error("stale UI"); } });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(attempts, 1);
  assert.deepEqual(current.notifications, []);
});

test("shutdown suppresses a recovery result already in flight", async (t) => {
  let attempts = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const current = setup({
    ensure: async () => ++attempts === 1 ? { kind: "busy", skillUpdated: false } : pending,
  });
  t.after(() => current.handlers.get("session_shutdown")({ reason: "exit" }));
  await current.handlers.get("session_start")({ reason: "reload" }, current.ctx);
  await waitFor(() => attempts === 2);
  current.handlers.get("session_shutdown")({ reason: "reload" });
  Object.defineProperty(current.ctx, "ui", { get() { throw new Error("stale UI"); } });
  Object.defineProperty(current.ctx, "hasUI", { get() { throw new Error("stale UI"); } });
  finish({ kind: "updated", skillUpdated: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(current.notifications, []);
});

test("cached session_start uses an event context with no reload and notifies the user", async () => {
  const { handlers, ctx, notifications, finish } = setup();
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(ctx.reload, undefined);
  finish({ kind: "updated", skillUpdated: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Run \/reload/);
});

test("a committed background update reports warnings without losing its reload prompt", async () => {
  const { handlers, ctx, notifications, finish } = setup();
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  finish({ kind: "updated", skillUpdated: true, warnings: ["Skill is active, but writing active.json failed"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Run \/reload/);
  assert.match(notifications[0], /Warning: .*active.json failed/);
});

test("a committed manual update reports warnings and asks for /reload", async () => {
  const { commands, ctx, notifications, finish } = setup();
  ctx.ui.setStatus = () => {};
  ctx.reload = async () => { throw new Error("manual update must not reload"); };
  const task = commands.get("webbridge-update").handler("", ctx);
  finish({ kind: "updated", skillUpdated: true, version: "v1.2.3", warnings: ["Skill is active, but update bookkeeping failed"] });
  await task;
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /^Updated Kimi WebBridge skill to v1\.2\.3\. Run \/reload to load the updated skill\./);
  assert.match(notifications[0], /Warning: .*bookkeeping failed/);
});

test("a failed manual update still asks for /reload after a background publication", async () => {
  let finishBackground;
  let failManual;
  const results = [
    new Promise((resolve) => { finishBackground = resolve; }),
    new Promise((_resolve, reject) => { failManual = reject; }),
  ];
  const { handlers, commands, ctx, notifications } = setup({ ensure: () => results.shift() });
  ctx.ui.setStatus = () => {};
  ctx.reload = async () => { throw new Error("manual update must not reload"); };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const task = commands.get("webbridge-update").handler("", ctx);
  finishBackground({ kind: "updated", skillUpdated: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, []);
  failManual(new Error("offline"));
  await task;
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0], "Kimi WebBridge update failed: offline");
  assert.match(notifications[1], /Run \/reload/);
});

test("a manual reload prompt is not repeated by a later background result", async () => {
  let finishBackground;
  let releaseBackgroundRead;
  const results = [
    new Promise((resolve) => { finishBackground = resolve; }),
    Promise.resolve({ kind: "updated", skillUpdated: true }),
  ];
  const publications = [
    Promise.resolve("release-a"),
    new Promise((resolve) => { releaseBackgroundRead = () => resolve("release-b"); }),
  ];
  const { handlers, commands, ctx, notifications } = setup({
    ensure: () => results.shift(),
    readSkillPublication: () => publications.shift(),
  });
  ctx.ui.setStatus = () => {};
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const task = commands.get("webbridge-update").handler("", ctx);
  // The background result is held in its publication read until the manual
  // command has finished and prompted for /reload.
  finishBackground({ kind: "updated", skillUpdated: true });
  await task;
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /^Updated Kimi WebBridge skill\. Run \/reload/);
  releaseBackgroundRead();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publications.length, 0);
  assert.equal(notifications.length, 1);
});

test("a background update without a UI stays silent", async (t) => {
  const { handlers, ctx, finish } = setup();
  const stderr = t.mock.method(console, "error", () => {});
  ctx.hasUI = false;
  ctx.ui.notify = () => {};
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  finish({ kind: "updated", skillUpdated: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stderr.mock.callCount(), 0);
});

test("shutdown makes a late background result leave the old UI alone", async () => {
  const { handlers, ctx, notifications, finish } = setup();
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  handlers.get("session_shutdown")({ reason: "reload" });
  Object.defineProperty(ctx, "ui", { get() { throw new Error("stale UI"); } });
  Object.defineProperty(ctx, "hasUI", { get() { throw new Error("stale UI"); } });
  finish({ kind: "updated", skillUpdated: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, []);
});
