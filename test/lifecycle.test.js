import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillReloadCoordinator,
  createUpdateRunner,
  runInitialUpdate,
  runManualUpdate,
  startBackgroundUpdate,
  startInitialBusyRecovery,
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

test("a successful background skill update requests a reload callback", async () => {
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
  const cancel = startInitialBusyRecovery(
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

test("a deferred background reload is consumed when a manual update fails", async () => {
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

test("manual update clears UI state before reload invalidates the old context", async () => {
  const statuses = [];
  const notifications = [];
  let active = true;
  const ctx = {
    ui: {
      setStatus(key, value) {
        assert.equal(active, true);
        statuses.push([key, value]);
      },
      notify(message, level) {
        assert.equal(active, true);
        notifications.push([message, level]);
      },
    },
    async reload() {
      assert.equal(statuses.at(-1)?.[1], undefined);
      active = false;
    },
  };

  const reloaded = await runManualUpdate({
    ctx,
    update: async (force) => {
      assert.equal(force, true);
      return { kind: "updated", skillUpdated: true };
    },
    formatUpdate: () => "updated",
  });

  assert.deepEqual(statuses, [
    ["pi-kimi-webbridge-bootstrap", "Updating Kimi WebBridge…"],
    ["pi-kimi-webbridge-bootstrap", undefined],
  ]);
  assert.deepEqual(notifications, [["updated", "info"]]);
  assert.equal(active, false);
  assert.equal(reloaded, true);
});
