import assert from "node:assert/strict";
import test from "node:test";
import { createSkillReloadCoordinator, runInitialUpdate, startBusyRecovery } from "../src/lifecycle.js";

test("background updates notify only once without needing command-context reload", async () => {
  const coordinator = createSkillReloadCoordinator();
  const notifications = [];
  const eventContext = { ui: { notify: (message) => notifications.push(message) } };
  const notify = () => eventContext.ui.notify("Run /reload");
  await coordinator.handleBackgroundResult({ skillUpdated: false }, notify);
  assert.equal(notifications.length, 0);
  await coordinator.handleBackgroundResult({ skillUpdated: true }, notify);
  await coordinator.handleBackgroundResult({ skillUpdated: true }, notify);
  assert.deepEqual(notifications, ["Run /reload"]);
});

test("shutdown suppresses late background notifications and pending manual notifications", async () => {
  const coordinator = createSkillReloadCoordinator();
  const stale = () => { throw new Error("stale context"); };
  coordinator.beginManual();
  await coordinator.handleBackgroundResult({ skillUpdated: true }, stale);
  coordinator.dispose();
  coordinator.dispose();
  assert.equal(coordinator.active, false);
  await coordinator.handleBackgroundResult({ skillUpdated: true }, stale);
  await coordinator.finishManual(false, stale);
});

test("a manual reload prompt consumes pending and later background notifications", async () => {
  const coordinator = createSkillReloadCoordinator();
  let calls = 0;
  coordinator.beginManual();
  await coordinator.handleBackgroundResult({ skillUpdated: true }, () => calls++);
  await coordinator.finishManual(true, () => calls++);
  await coordinator.handleBackgroundResult({ skillUpdated: true }, () => calls++);
  assert.equal(calls, 0);
});

test("initial setup does not notify through a stale event context after shutdown", async () => {
  let active = true;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const run = runInitialUpdate({
    ctx: { ui: { notify() { throw new Error("stale context"); } } },
    update: () => pending, formatUpdate: () => "updated", isActive: () => active,
  });
  active = false;
  finish({ kind: "updated", skillUpdated: true });
  assert.equal((await run).kind, "updated");
});

test("shutdown cancels initial busy recovery before its next update", async () => {
  let finishDelay;
  let calls = 0;
  const waiting = new Promise((resolve) => { finishDelay = resolve; });
  const cancel = startBusyRecovery(async () => { calls++; }, () => {
    throw new Error("stale callback");
  }, { delay: () => waiting });
  cancel();
  finishDelay();
  await waiting;
  await Promise.resolve();
  assert.equal(calls, 0);
});
