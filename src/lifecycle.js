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

export function startInitialBusyRecovery(update, onReady, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let cancelled = false;

  void (async () => {
    while (!cancelled && now() < deadline) {
      await delay(retryDelayMs);
      if (cancelled) return;
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
  let manualDepth = 0;
  let pendingSkillReload = false;

  return {
    beginManual() {
      manualDepth += 1;
    },
    async handleBackgroundResult(result, reload) {
      if (result.skillUpdated !== true) return;
      if (manualDepth > 0) {
        pendingSkillReload = true;
        return;
      }
      await reload();
    },
    async finishManual(reloaded, reload) {
      manualDepth = Math.max(0, manualDepth - 1);
      if (manualDepth > 0 || !pendingSkillReload) return;
      pendingSkillReload = false;
      if (!reloaded) await reload();
    },
  };
}

export async function runInitialUpdate({ ctx, update, formatUpdate }) {
  const result = await update(false);
  if (result.kind === "busy") {
    ctx.ui.notify(formatUpdate(result), "warning");
    return result;
  }
  if (result.kind === "updated") ctx.ui.notify(formatUpdate(result), "info");
  return result;
}

export async function runManualUpdate({ ctx, update, formatUpdate }) {
  ctx.ui.setStatus("pi-kimi-webbridge-bootstrap", "Updating Kimi WebBridge…");
  let shouldReload = false;
  try {
    const result = await update(true);
    ctx.ui.notify(formatUpdate(result), result.kind === "busy" ? "warning" : "info");
    shouldReload = result.skillUpdated === true;
  } catch (error) {
    ctx.ui.notify(
      `Kimi WebBridge update failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    ctx.ui.setStatus("pi-kimi-webbridge-bootstrap", undefined);
  }
  if (shouldReload) {
    await ctx.reload();
    return true;
  }
  return false;
}
