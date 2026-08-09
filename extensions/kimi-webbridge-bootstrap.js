import { homedir } from "node:os";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  createUpdateRunner,
  createSkillReloadCoordinator,
  runInitialUpdate,
  runManualUpdate,
  startBackgroundUpdate,
  startInitialBusyRecovery,
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

function formatUpdate(result) {
  if (result.kind === "busy") return "Another Pi session is already updating Kimi WebBridge.";
  if (result.kind === "ready") return `Kimi WebBridge is current${result.version ? ` (${result.version})` : ""}.`;
  const parts = [result.cliUpdated ? "CLI" : undefined, result.skillUpdated ? "skill" : undefined].filter(Boolean);
  return `Updated Kimi WebBridge ${parts.join(" and ")}${result.version ? ` to ${result.version}` : ""}.`;
}

export default function webbridgeBootstrap(pi) {
  const manager = new WebbridgeManager({
    agentDir: getAgentDir(),
    userHomeDir: homedir(),
  });
  const update = createUpdateRunner((force) => manager.ensure({ force }));
  const reloadCoordinator = createSkillReloadCoordinator();
  let cancelInitialRecovery;

  pi.on("session_start", async (_event, ctx) => {
    if (!manager.autoUpdateEnabled()) return;
    const hasSkill = await manager.hasSkill();
    if (hasSkill) {
      cancelInitialRecovery?.();
      cancelInitialRecovery = undefined;
      // Pi awaits session_start handlers before discovering resources. Keep an
      // existing skill immediately usable and let the guarded updater finish in
      // the background. Its failure is persisted in state.json for /status.
      startBackgroundUpdate(update, async (result) => {
        await reloadCoordinator.handleBackgroundResult(result, () => ctx.reload());
      });
      return;
    }

    try {
      const result = await runInitialUpdate({ ctx, update, formatUpdate });
      if (result.kind === "busy") {
        cancelInitialRecovery?.();
        cancelInitialRecovery = startInitialBusyRecovery(update, async (retryResult) => {
          if (!(await manager.hasSkill())) return;
          cancelInitialRecovery?.();
          cancelInitialRecovery = undefined;
          await reloadCoordinator.handleBackgroundResult(
            { ...retryResult, skillUpdated: true },
            () => ctx.reload(),
          );
        });
        return;
      }
      const status = await manager.inspect();
      if (status.daemon?.extension_connected !== true) {
        ctx.ui.notify(formatBrowserExtensionGuide(), "warning");
      }
    } catch (error) {
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
      let reloaded = false;
      try {
        reloaded = await runManualUpdate({ ctx, update, formatUpdate });
      } finally {
        if (reloaded) {
          cancelInitialRecovery?.();
          cancelInitialRecovery = undefined;
        }
        await reloadCoordinator.finishManual(reloaded, () => ctx.reload());
      }
    },
  });
}
