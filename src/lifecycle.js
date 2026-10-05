export function createUpdateRunner(ensure) {
  let running;
  let runningForce = false;
  let forcedFollowup;

  const launch = (force) => {
    runningForce = force;
    const task = Promise.resolve().then(() => ensure(force));
    running = task;
    void task
      .finally(() => {
        if (running === task) {
          running = undefined;
          runningForce = false;
        }
      })
      .catch(() => undefined);
    return task;
  };

  return (force) => {
    if (running === undefined) return launch(force);
    if (!force || runningForce) return running;
    if (forcedFollowup === undefined) {
      const queued = running.catch(() => undefined).then(() => launch(true));
      forcedFollowup = queued;
      void queued
        .finally(() => {
          if (forcedFollowup === queued) forcedFollowup = undefined;
        })
        .catch(() => undefined);
    }
    return forcedFollowup;
  };
}

export function startBackgroundUpdate(update, onResult) {
  void update(false)
    .then((result) => onResult?.(result))
    .catch(() => undefined);
}

export function startBusyRecovery(update, onReady, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let cancelled = false;

  void (async () => {
    while (!cancelled && now() < deadline) {
      await delay(retryDelayMs);
      if (cancelled || now() >= deadline) return;
      const result = await update(false);
      if (result.kind === "busy") continue;
      if (!cancelled) await onReady(result);
      return;
    }
  })().catch(() => undefined);

  return () => {
    cancelled = true;
  };
}

export function createSkillReloadCoordinator() {
  let active = true;
  let manualDepth = 0;
  let pendingSkillReload = false;
  let notified = false;

  return {
    get active() {
      return active;
    },
    dispose() {
      active = false;
      pendingSkillReload = false;
    },
    beginManual() {
      if (active) manualDepth += 1;
    },
    async handleBackgroundResult(result, notify) {
      if (!active || result.skillUpdated !== true || notified) return;
      if (manualDepth > 0) {
        pendingSkillReload = true;
        return;
      }
      // Event contexts cannot reload. Notify once; the user owns /reload.
      notified = true;
      await notify();
    },
    async finishManual(reloadPrompted, notify) {
      if (!active) return;
      manualDepth = Math.max(0, manualDepth - 1);
      // A manual update that changed the skill has already asked for /reload.
      if (reloadPrompted) notified = true;
      if (manualDepth > 0 || !pendingSkillReload) return;
      pendingSkillReload = false;
      if (!notified) {
        notified = true;
        await notify();
      }
    },
  };
}

export async function runInitialUpdate({ ctx, update, formatUpdate, isActive = () => true }) {
  const result = await update(false);
  if (!isActive()) return result;
  if (result.kind === "busy") {
    ctx.ui.notify(formatUpdate(result), "warning");
    return result;
  }
  if (result.kind === "updated") ctx.ui.notify(formatUpdate(result), "info");
  return result;
}

export async function runManualUpdate({ ctx, update, formatUpdate }) {
  ctx.ui.setStatus("pi-kimi-webbridge-bootstrap", "Updating Kimi WebBridge…");
  try {
    const result = await update(true);
    ctx.ui.notify(formatUpdate(result), result.kind === "busy" ? "warning" : "info");
    // Pi cannot confirm an extension-triggered reload (it ignores reloads while
    // streaming or compacting), so formatUpdate asks the user to run /reload.
    return result.skillUpdated === true;
  } catch (error) {
    ctx.ui.notify(
      `Kimi WebBridge update failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  } finally {
    ctx.ui.setStatus("pi-kimi-webbridge-bootstrap", undefined);
  }
}
