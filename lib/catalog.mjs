import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 策展 JSON 体积小，每次读取以便热更新安装副本后无需改代码重启逻辑依赖 */
export function loadCatalog() {
  const p = join(ROOT, "data", "providers.json");
  if (!existsSync(p)) {
    return { version: 0, providers: [], updatedAt: "", note: "catalog missing" };
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function getProvider(id) {
  const cat = loadCatalog();
  return (cat.providers || []).find((p) => p.id === id) || null;
}

export function publicCatalog() {
  const cat = loadCatalog();
  return {
    version: cat.version,
    updatedAt: cat.updatedAt,
    note: cat.note || "",
    providers: (cat.providers || []).map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      protocol: p.protocol || "openai",
      baseUrl: p.baseUrl || "",
      signupUrl: p.signupUrl || "",
      docsUrl: p.docsUrl || "",
      models: p.models || [],
      capabilities: Array.isArray(p.capabilities) ? p.capabilities : undefined,
      modelCapabilities:
        p.modelCapabilities && typeof p.modelCapabilities === "object"
          ? p.modelCapabilities
          : undefined,
      quotaHint: p.quotaHint || "",
      notes: p.notes || "",
    })),
  };
}
