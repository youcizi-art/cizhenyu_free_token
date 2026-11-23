import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

/** 工具数据面：安装目录 home/（与 Agent 配置隔离） */
export function homeDir() {
  const d = join(ROOT, "home");
  mkdirSync(d, { recursive: true });
  return d;
}

export function configPath() {
  return join(homeDir(), "config.json");
}

export function pidPath() {
  return join(homeDir(), "gateway.pid");
}

export function portPath() {
  return join(homeDir(), "gateway.port");
}

export function logPath() {
  return join(homeDir(), "gateway.log");
}

export function defaultPort() {
  const n = Number(process.env.CIZHENYU_FREE_TOKEN_PORT || 20188);
  return Number.isFinite(n) && n > 0 ? n : 20188;
}

export function resolveNode() {
  return process.execPath;
}

/** Windows 无窗 node 不可靠时仍用 node；日志重定向即可 */
export function ensureHome() {
  const h = homeDir();
  if (!existsSync(h)) mkdirSync(h, { recursive: true });
  return h;
}

export function fallbackStateHint() {
  return join(homedir(), ".cizhenyu-free-token");
}
