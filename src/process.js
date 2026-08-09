import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function appendLimited(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return `${current}${chunk}`.slice(0, MAX_OUTPUT_BYTES);
}

export function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export async function runChecked(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code === 0 && !result.timedOut) return result;

  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  const reason = result.timedOut ? `timed out after ${options.timeoutMs ?? 30_000}ms` : detail;
  throw new Error(`${command} ${args.join(" ")} failed: ${reason}`);
}
