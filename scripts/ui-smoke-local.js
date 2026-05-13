"use strict";

/**
 * Local UI smoke wrapper.
 *
 * Starts the app server, waits until it's reachable, runs ui-smoke,
 * then stops the server process.
 */

const { spawn } = require("child_process");
const http = require("http");

const HOST = process.env.SMOKE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const BASE_URL = process.env.SMOKE_BASE_URL || `http://${HOST}:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 30000;
const SERVER_POLL_INTERVAL_MS = 500;

function runNpmScript(scriptCommand, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptCommand, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...extraEnv }
    });

    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${scriptCommand} exited with code ${code}`));
    });
  });
}

function probeUrl(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      resolve(true);
    });

    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await probeUrl(url);
    if (ok) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
  }
  throw new Error(`server not reachable at ${url} after ${timeoutMs}ms`);
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.killed) {
      resolve();
      return;
    }

    const done = () => resolve();
    child.once("exit", done);

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      killer.once("exit", done);
      killer.once("error", done);
      return;
    }

    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 2000);
  });
}

async function main() {
  console.log(`[ui-smoke-local] starting server on ${BASE_URL}`);
  const server = spawn("npm start", {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PORT: String(PORT) }
  });

  let processExitCode = 0;
  try {
    await waitForServer(BASE_URL, SERVER_READY_TIMEOUT_MS);
    console.log(`[ui-smoke-local] server reachable, running smoke`);
    await runNpmScript("npm run smoke:ui", { SMOKE_BASE_URL: BASE_URL });
    console.log("[ui-smoke-local] smoke passed");
  } catch (err) {
    processExitCode = 1;
    console.error(`[ui-smoke-local] FAILED: ${err.message}`);
  } finally {
    await stopServer(server);
  }

  process.exit(processExitCode);
}

main().catch(err => {
  console.error("[ui-smoke-local] fatal:", err);
  process.exit(1);
});
