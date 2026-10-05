import { homedir } from "node:os";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  createUpdateRunner,
  createSkillReloadCoordinator,
  runInitialUpdate,
  runManualUpdate,
  startBackgroundUpdate,
  startBusyRecovery,
} from "../src/lifecycle.js";
import { WebbridgeManager } from "../src/manager.js";

const BROWSER_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc";

function formatBrowserExtensionGuide() {
  return [
    "Kimi WebBridge browser extension is not connected.",
    `If it is not installed, install it from the Chrome Web Store: ${BROWSER_EXTENSION_URL}`,
    "Enable the extension, then run /webbridge-status to verify the connection.",
  ].join("\n");
}

function formatStatus(status) {
  const daemonVersion = status.daemon?.version ?? status.state.cliVersion ?? "unknown";
  const daemon = status.daemon?.running === true ? `running (${daemonVersion})` : status.cliInstalled ? "not running" : "not installed";
  const extensionConnected = status.daemon?.extension_connected === true;
  const extension = extensionConnected ? "connected" : "not connected";
  const skill = status.skillInstalled ? status.state.skillVersion ?? "installed" : "not installed";
  const error = status.state.lastError === undefined ? "" : `\nLast update error: ${status.state.lastError}`;
  const extensionGuide = extensionConnected ? "" : `\n\n${formatBrowserExtensionGuide()}`;
  return `WebBridge daemon: ${daemon}\nBrowser extension: ${extension}\nPi skill: ${skill}\nCLI: ${status.cliPath}\nSkill: ${status.skillRoot}${error}${extensionGuide}`;
}

function formatWarnings(warnings = []) {
  return warnings.map((warning) => `\nWarning: ${warning}`).join("");
}

function formatUpdate(result, { reloadHint = false } = {}) {
  if (result.kind === "busy") return "Another Pi session is already updating Kimi WebBridge.";
  if (result.kind === "ready") return `Kimi WebBridge is current${result.version ? ` (${result.version})` : ""}.`;
  const parts = [result.cliUpdated ? "CLI" : undefined, result.skillUpdated ? "skill" : undefined].filter(Boolean);
  const hint = reloadHint && result.skillUpdated ? " Run /reload to load the updated skill." : "";
  return `Updated Kimi WebBridge ${parts.join(" and ")}${result.version ? ` to ${result.version}` : ""}.${hint}${formatWarnings(result.warnings)}`;
}

const formatManualUpdate = (result) => formatUpdate(result, { reloadHint: true });

export default function webbridgeBootstrap(pi) {
  const manager = new WebbridgeManager({
    agentDir: getAgentDir(),
    userHomeDir: homedir(),
  });
  registerWebbridgeBootstrap(pi, manager);
}

export function registerWebbridgeBootstrap(pi, manager) {
  const update = createUpdateRunner((force) => manager.ensure({ force }));
  const reloadCoordinator = createSkillReloadCoordinator();
  let cancelRecovery;
  const notifySkillUpdate = (ctx, warnings = []) => {
    if (!reloadCoordinator.active) return;
    const message = `Kimi WebBridge skill updated. Run /reload to load the updated skill.${formatWarnings(warnings)}`;
    // Without a UI, notify is a no-op; /reload is unavailable there anyway.
    ctx.ui.notify(message, warnings.length > 0 ? "warning" : "info");
  };

  pi.on("session_shutdown", () => {
    reloadCoordinator.dispose();
    cancelRecovery?.();
    cancelRecovery = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!manager.autoUpdateEnabled()) return;
    const hasSkill = await manager.hasSkill();
    if (!reloadCoordinator.active) return;
    if (hasSkill) {
      cancelRecovery?.();
      cancelRecovery = undefined;
      const initialPublication = await manager.readSkillPublication();
      if (!reloadCoordinator.active) return;
      const handleReady = async (result) => {
        if (!reloadCoordinator.active) return;
        const publication = await manager.readSkillPublication();
        // Another runtime may have published the skill while we were busy.
        // Its result is lost on reload; our own check can legitimately be "ready".
        const skillUpdated =
          result.skillUpdated === true ||
          (publication !== undefined && publication !== initialPublication);
        await reloadCoordinator.handleBackgroundResult(
          { ...result, skillUpdated },
          () => notifySkillUpdate(ctx, result.warnings),
        );
      };
      // Pi awaits session_start handlers before discovering resources. Keep an
      // existing skill immediately usable and let the guarded updater finish in
      // the background. Its failure is persisted in state.json for /status.
      startBackgroundUpdate(update, async (result) => {
        if (!reloadCoordinator.active) return;
        if (result.kind === "busy") {
          cancelRecovery = startBusyRecovery(update, handleReady);
          return;
        }
        await handleReady(result);
      });
      return;
    }

    try {
      const result = await runInitialUpdate({ ctx, update, formatUpdate, isActive: () => reloadCoordinator.active });
      if (!reloadCoordinator.active) return;
      if (result.kind === "busy") {
        cancelRecovery?.();
        cancelRecovery = startBusyRecovery(update, async (retryResult) => {
          if (!reloadCoordinator.active || !(await manager.hasSkill()) || !reloadCoordinator.active) return;
          cancelRecovery?.();
          cancelRecovery = undefined;
          await reloadCoordinator.handleBackgroundResult(
            { ...retryResult, skillUpdated: true },
            () => notifySkillUpdate(ctx, retryResult.warnings),
          );
        });
        return;
      }
      const status = await manager.inspect();
      if (!reloadCoordinator.active) return;
      if (status.daemon?.extension_connected !== true) {
        ctx.ui.notify(formatBrowserExtensionGuide(), "warning");
      }
    } catch (error) {
      if (!reloadCoordinator.active) return;
      ctx.ui.notify(
        `Kimi WebBridge automatic setup failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });

  pi.on("resources_discover", async () => {
    if (!(await manager.hasSkill())) return {};
    return { skillPaths: [manager.skillRoot] };
  });

  pi.registerCommand("webbridge-status", {
    description: "Show Kimi WebBridge runtime, extension, skill, and updater status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatStatus(await manager.inspect()), "info");
    },
  });

  pi.registerCommand("webbridge-setup", {
    description: "Show Kimi WebBridge browser extension installation guidance",
    handler: async (_args, ctx) => {
      const status = await manager.inspect();
      if (status.daemon?.extension_connected === true) {
        ctx.ui.notify("Kimi WebBridge browser extension is connected.", "info");
        return;
      }
      ctx.ui.notify(formatBrowserExtensionGuide(), "warning");
    },
  });

  pi.registerCommand("webbridge-update", {
    description: "Check and install the latest compatible Kimi WebBridge CLI and Pi skill",
    handler: async (_args, ctx) => {
      reloadCoordinator.beginManual();
      let reloadPrompted = false;
      try {
        reloadPrompted = await runManualUpdate({ ctx, update, formatUpdate: formatManualUpdate });
      } finally {
        if (reloadPrompted) {
          cancelRecovery?.();
          cancelRecovery = undefined;
        }
        // A concurrent background check may have published a skill even when
        // this manual update failed; ask for /reload once in that case.
        await reloadCoordinator.finishManual(reloadPrompted, () => notifySkillUpdate(ctx));
      }
    },
  });
}
