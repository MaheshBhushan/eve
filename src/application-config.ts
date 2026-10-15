import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ApplicationConfig {
  enabled: boolean;
  authorized: boolean;
  destination: string;
  dbPath: string;
  stateDir: string;
  ruddrPath: string;
  skillsDir: string;
  model: "gpt-6.1-sol";
  effort: "low" | "medium";
  sandbox: "workspace-write" | "danger-full-access";
  writableDirs: string[];
  maxJobs: number;
  enqueueLimit: number;
  maxAttempts: number;
  maxRepairs: number;
  timeoutSeconds: number;
  leaseSeconds: number;
  telegramToken: string | null;
  telegramChatId: string | null;
  telegramTimeoutSeconds: number;
}

export function loadApplicationConfig(env: NodeJS.ProcessEnv = process.env): ApplicationConfig {
  const key = (name: string) => `EVE_APPLICATION_${name}`;
  const bool = (name: string) => {
    const value = env[key(name)] ?? "false";
    if (value !== "true" && value !== "false") throw new Error(`${key(name)} must be true or false`);
    return value === "true";
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[key(name)] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new Error(`${key(name)} must be an integer from ${min} to ${max}`);
    }
    return Number(value);
  };
  const enabled = bool("ENABLED");
  const authorized = bool("AUTHORIZED_TEST_SYSTEM");
  const destination = env[key("DESTINATION")] ?? "";
  if (destination) {
    let url: URL;
    try { url = new URL(destination); } catch { throw new Error("EVE_APPLICATION_DESTINATION must be an absolute URL"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (destination !== destination.trim() || url.username || url.password || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
      throw new Error("EVE_APPLICATION_DESTINATION requires HTTPS (HTTP only on loopback), no credentials or fragment");
    }
  }
  if (enabled && (!authorized || !destination)) {
    throw new Error("Enabled applications require EVE_APPLICATION_AUTHORIZED_TEST_SYSTEM=true and EVE_APPLICATION_DESTINATION");
  }
  const model = env[key("MODEL")] ?? "gpt-6.1-sol";
  if (model !== "gpt-6.1-sol") throw new Error("EVE_APPLICATION_MODEL must be gpt-6.1-sol");
  const effort = env[key("EFFORT")] ?? "medium";
  if (effort !== "low" && effort !== "medium") throw new Error("EVE_APPLICATION_EFFORT must be low or medium");
  const sandbox = env[key("SANDBOX")] ?? "workspace-write";
  if (sandbox !== "workspace-write" && sandbox !== "danger-full-access") throw new Error("EVE_APPLICATION_SANDBOX must be workspace-write or danger-full-access");
  let writableDirs: unknown;
  try { writableDirs = JSON.parse(env[key("WRITABLE_DIRS")] ?? "[]"); }
  catch { throw new Error("EVE_APPLICATION_WRITABLE_DIRS must be a JSON array of absolute paths"); }
  if (!Array.isArray(writableDirs) || !writableDirs.every((dir): dir is string => typeof dir === "string" && isAbsolute(dir) && dir !== "/")) {
    throw new Error("EVE_APPLICATION_WRITABLE_DIRS must be a JSON array of absolute directories other than /");
  }
  const telegramToken = env[key("TELEGRAM_TOKEN")] || null;
  const telegramChatId = env[key("TELEGRAM_CHAT_ID")] || null;
  if (Boolean(telegramToken) !== Boolean(telegramChatId)) throw new Error("Configure both EVE_APPLICATION_TELEGRAM_TOKEN and EVE_APPLICATION_TELEGRAM_CHAT_ID or neither");
  return {
    enabled, authorized, destination,
    dbPath: env.RADAR_DB_PATH ?? env.RADAR_DB ?? "eve.db",
    stateDir: resolve(env[key("STATE_DIR")] ?? join(homedir(), ".local/state/eve/applications")),
    ruddrPath: env[key("RUDDR_PATH")] || "ruddr",
    skillsDir: resolve(env[key("SKILLS_DIR")] ?? join(homedir(), ".codex/skills")),
    model, effort, sandbox, writableDirs,
    maxJobs: integer("MAX_JOBS", 3, 1, 100),
    enqueueLimit: integer("ENQUEUE_LIMIT", 1000, 1, 10000),
    maxAttempts: integer("MAX_ATTEMPTS", 3, 1, 10),
    maxRepairs: integer("MAX_REPAIRS", 2, 1, 5),
    timeoutSeconds: integer("TIMEOUT_SECONDS", 1200, 10, 7200),
    leaseSeconds: integer("LEASE_SECONDS", 120, 30, 600),
    telegramToken, telegramChatId,
    telegramTimeoutSeconds: integer("TELEGRAM_TIMEOUT_SECONDS", 10, 1, 60),
  };
}

export function requireApplicationExecution(config: ApplicationConfig): void {
  if (!config.enabled || !config.authorized || !config.destination) throw new Error("Application execution is disabled; configure explicit test authorization and destination first");
}
