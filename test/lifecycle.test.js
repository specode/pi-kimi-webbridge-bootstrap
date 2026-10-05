import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillReloadCoordinator,
  createUpdateRunner,
  runInitialUpdate,
  runManualUpdate,
  startBackgroundUpdate,
  startBusyRecovery,
} from "../src/lifecycle.js";

test("cached startup launches the updater without awaiting it", async () => {
  let force;
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const result = startBackgroundUpdate(async (value) => {
    force = value;
    await pending;
  });

  assert.equal(result, undefined);
  assert.equal(force, false);
  finish();
  await pending;
});

test("a forced update is queued behind an in-flight periodic check", async () => {
  const calls = [];
  let finishPeriodic;
  const periodic = new Promise((resolve) => {
    finishPeriodic = resolve;
  });
  const update = createUpdateRunner(async (force) => {
    calls.push(force);
    if (!force) await periodic;
    return { kind: "ready", force };
  });

  const first = update(false);
  await Promise.resolve();
  const forced = update(true);
  assert.deepEqual(calls, [false]);
  finishPeriodic();

  assert.deepEqual(await first, { kind: "ready", force: false });
  assert.deepEqual(await forced, { kind: "ready", force: true });
  assert.deepEqual(calls, [false, true]);
});

test("initial setup reports a busy updater as a warning", async () => {
  const notifications = [];
  const result = await runInitialUpdate({
    ctx: { ui: { notify: (...args) => notifications.push(args) } },
    update: async (force) => {
      assert.equal(force, false);
      return { kind: "busy", skillUpdated: false };
    },
    formatUpdate: () => "another session is updating",
  });

  assert.equal(result.kind, "busy");
  assert.deepEqual(notifications, [["another session is updating", "warning"]]);
});

test("a successful background skill update reports its result", async () => {
  let reloaded = false;
  let finished;
  const completion = new Promise((resolve) => {
    finished = resolve;
  });
  startBackgroundUpdate(
    async () => ({ kind: "updated", skillUpdated: true }),
    async (result) => {
      assert.equal(result.skillUpdated, true);
      reloaded = true;
      finished();
    },
  );

  await completion;
  assert.equal(reloaded, true);
});

test("a busy initial setup retries in the background until it can continue", async () => {
  const calls = [];
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });
  const cancel = startBusyRecovery(
    async (force) => {
      assert.equal(force, false);
      calls.push(force);
      return calls.length === 1
        ? { kind: "busy", skillUpdated: false }
        : { kind: "updated", skillUpdated: true };
    },
    async (result) => {
      assert.equal(result.kind, "updated");
      finish();
    },
    { retryDelayMs: 0, timeoutMs: 1_000 },
  );

  assert.equal(typeof cancel, "function");
  await completed;
  assert.equal(calls.length, 2);
});

test("busy recovery stops at its deadline without a final out-of-budget update", async () => {
  let now = 0;
  let calls = 0;
  let notified = false;
  startBusyRecovery(
    async () => {
      calls += 1;
      return { kind: "busy", skillUpdated: false };
    },
    () => { notified = true; },
    {
      timeoutMs: 3,
      retryDelayMs: 1,
      now: () => now,
      delay: async (ms) => { now += ms; },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(now, 3);
  assert.equal(calls, 2);
  assert.equal(notified, false);
});

test("a deferred background notification is delivered when a manual update fails", async () => {
  const coordinator = createSkillReloadCoordinator();
  let reloads = 0;
  coordinator.beginManual();
  await coordinator.handleBackgroundResult(
    { kind: "updated", skillUpdated: true },
    async () => {
      reloads += 1;
    },
  );
  assert.equal(reloads, 0);

  await coordinator.finishManual(false, async () => {
    reloads += 1;
  });
  assert.equal(reloads, 1);
});

test("manual update asks for /reload instead of reloading itself", async () => {
  const statuses = [];
  const notifications = [];
  const ctx = {
    ui: {
      setStatus: (key, value) => statuses.push([key, value]),
      notify: (message, level) => notifications.push([message, level]),
    },
    reload: async () => { throw new Error("Pi cannot confirm extension reloads"); },
  };

  const reloadPrompted = await runManualUpdate({
    ctx,
    update: async (force) => {
      assert.equal(force, true);
      return { kind: "updated", skillUpdated: true };
    },
    formatUpdate: () => "updated; run /reload",
  });

  assert.deepEqual(statuses, [
    ["pi-kimi-webbridge-bootstrap", "Updating Kimi WebBridge…"],
    ["pi-kimi-webbridge-bootstrap", undefined],
  ]);
  assert.deepEqual(notifications, [["updated; run /reload", "info"]]);
  assert.equal(reloadPrompted, true);
});
