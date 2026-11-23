#!/usr/bin/env node
/**
 * 启停本机 Free Token 网关（对齐 Crawl4AI manage.py 用法）
 *
 *   node manage.mjs start|stop|status|serve|open
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  mkdirSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { loadConfig } from "./lib/config.mjs";
import {
  restoreOnGatewayDown,
  reconcileIfStale,
} from "./lib/agent_wire.mjs";
import {
  ROOT,
  ensureHome,
  pidPath,
  portPath,
  logPath,
  resolveNode,
  defaultPort,
} from "./lib/paths.mjs";

const cmd = (process.argv[2] || "status").toLowerCase();

function readPid() {
  if (!existsSync(pidPath())) return null;
  const n = Number(readFileSync(pidPath(), "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readPort() {
  if (existsSync(portPath())) {
    const n = Number(readFileSync(portPath(), "utf8").trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return loadConfig().port || defaultPort();
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(400, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function cmdStatus() {
  const port = readPort();
  const h = await health(port);
  const running = Boolean(h?.ok);
  try {
    reconcileIfStale(running);
  } catch {
    /* ignore */
  }
  if (running) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          running: true,
          port,
          pid: readPid(),
          ui: `http://127.0.0.1:${port}/`,
          v1: `http://127.0.0.1:${port}/v1`,
          ...h,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(JSON.stringify({ ok: false, running: false, port, message: "down" }));
  return 1;
}

async function cmdStart() {
  ensureHome();
  const cfg = loadConfig();
  const port = cfg.port || defaultPort();
  const existing = await health(port);
  if (existing?.ok) {
    // 不在 start 时自动接线；由配置页「重新接线」显式触发
    console.log(`already running: http://127.0.0.1:${port}/`);
    console.log(JSON.stringify({ ok: true, running: true, port }));
    return 0;
  }

  const logFile = logPath();
  mkdirSync(join(ROOT, "home"), { recursive: true });
  const outFd = openSync(logFile, "a");
  const node = resolveNode();
  const child = spawn(node, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, CIZHENYU_FREE_TOKEN_PORT: String(port) },
    windowsHide: true,
  });
  child.unref();
  writeFileSync(pidPath(), String(child.pid), "utf8");
  writeFileSync(portPath(), String(port), "utf8");

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await health(port);
    if (h?.ok) {
      console.log(`started: http://127.0.0.1:${port}/ (pid ${child.pid})`);
      console.log(`log    : ${logFile}`);
      console.log(JSON.stringify({ ok: true, running: true, port, pid: child.pid }));
      return 0;
    }
    if (!alive(child.pid) && i > 4) break;
  }
  console.error(`error: gateway not healthy; see ${logFile}`);
  return 1;
}

function killPid(pid) {
  if (!pid || !alive(pid)) return false;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

/** Windows：pid 文件丢失时，按监听端口找残留进程 */
function findPidByPortWin(port) {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const n = Number(String(r.stdout || "").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function cmdStop() {
  try {
    restoreOnGatewayDown();
  } catch (e) {
    console.error(`agent wire restore: ${e?.message || e}`);
  }
  const port = readPort();
  let pid = readPid();
  let killed = killPid(pid);
  if (!killed && (await portOpen(port))) {
    pid = findPidByPortWin(port) || pid;
    killed = killPid(pid);
  }
  for (let i = 0; i < 20; i++) {
    if (!(await portOpen(port))) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    unlinkSync(pidPath());
  } catch {
    /* ignore */
  }
  console.log(killed || pid ? `stopped pid ${pid || "?"}` : "not running");
  console.log(JSON.stringify({ ok: true, running: false, port }));
  return 0;
}

function cmdServe() {
  const cfg = loadConfig();
  process.env.CIZHENYU_FREE_TOKEN_PORT = String(cfg.port || defaultPort());
  const r = spawnSync(resolveNode(), [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  return r.status ?? 1;
}

async function cmdOpen() {
  const port = readPort();
  const url = `http://127.0.0.1:${port}/`;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
  console.log(url);
  return 0;
}

let code = 2;
if (cmd === "status") code = await cmdStatus();
else if (cmd === "start") code = await cmdStart();
else if (cmd === "stop") code = await cmdStop();
else if (cmd === "serve") code = cmdServe();
else if (cmd === "open") code = await cmdOpen();
else console.error("usage: node manage.mjs <start|stop|status|serve|open>");

process.exit(code);
