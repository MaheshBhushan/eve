import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * One HTTP layer for feed and API adapters.
 *
 * The adapters that existed before this file each grew their own `fetch` call,
 * which was fine while every source was a well-behaved ATS endpoint on its own
 * domain. Adding dozens of feeds changes the failure modes: a feed can redirect
 * to a login page, answer HTML instead of JSON, return a 7.9 MB body, or 429
 * one query while the rest of the site stays open. Each of those is a distinct
 * outcome, and collapsing them into `!response.ok -> throw` is exactly how a
 * blocked page becomes an empty snapshot downstream.
 *
 * So this module exists to make those distinctions explicit:
 *
 *   - per-host in-flight cap, so one adapter's detail fan-out cannot hammer a
 *     domain the way N independent query sources would;
 *   - byte limits enforced while reading, not after the whole body is in
 *     memory (DevOpsJobs' 7.9 MB feed is a real measurement, not a hypothetical);
 *   - ETag / Last-Modified round-trip for sources that honour conditional GETs;
 *   - content-type and JSON shape checks, so HTML is an error rather than
 *     "zero jobs";
 *   - bounded retries with jitter for transient failures, and no retry at all
 *     for a hard block;
 *   - every redirect hop validated: HTTP(S) only, no credentials in the URL,
 *     no private/link-local destinations, and a host allowlist supplied by the
 *     caller. A `links.next` from a compromised or misconfigured API must not
 *     become an SSRF.
 *
 * The domain *cooldown* (persisted, shared across every query source on a
 * throttled host) lives in db.ts and the poller, because it outlives a single
 * process and needs to survive a restart. What lives here is the per-call
 * behaviour.
 */

export type HttpFailureKind =
  /** 429/403 and similar: do not retry in a loop, record a cooldown. */
  | "blocked"
  /** A 4xx/5xx that is not a block; retried while transient. */
  | "http"
  /** DNS, connection reset, timeout. */
  | "network"
  /** The body exceeded the configured byte cap. */
  | "oversized"
  /** Too many hops, or a redirect that failed validation. */
  | "redirect"
  /** 2xx but not the shape we asked for (HTML at a JSON endpoint, bad JSON). */
  | "malformed";

export class HttpError extends Error {
  readonly kind: HttpFailureKind;
  readonly status: number | null;
  /** From `Retry-After`, when the server sent one. Seconds or HTTP-date both parse. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    kind: HttpFailureKind,
    opts: { status?: number | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "HttpError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export interface HttpResponse {
  status: number;
  /** Decoded body, or null on a 304 where there is deliberately nothing to read. */
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  contentType: string | null;
}

export interface HttpOptions {
  /** Replayed as If-None-Match. Store exactly what the server sent (weak tags included). */
  etag?: string | null;
  /** Replayed as If-Modified-Since. */
  lastModified?: string | null;
  headers?: Record<string, string>;
  accept?: string;
  /** Hard cap on the decoded body. Defaults to 5 MB. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Per-host in-flight requests. Defaults to 2. */
  perHost?: number;
  /**
   * Extra hosts a redirect may land on. Default: only the initial host.
   * Subdomains are NOT implied — pass a predicate when a source genuinely
   * redirects between hosts.
   */
  allowHost?: (host: string, initialHost: string) => boolean;
}

export const DEFAULT_MAX_BYTES = 5_000_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 4;
const MAX_ATTEMPTS = 3;
const RETRY_BLOCK_MS = 5_000;

/* ------------------------------------------------------- host gate --- */

interface HostGate {
  active: number;
  waiters: Array<() => void>;
}

const gates = new Map<string, HostGate>();

/** Test hook: forget in-flight accounting between cases. */
export function resetHttpGates(): void {
  gates.clear();
}

async function withHostSlot<T>(host: string, limit: number, run: () => Promise<T>): Promise<T> {
  let gate = gates.get(host);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    gates.set(host, gate);
  }
  if (gate.active >= limit) {
    await new Promise<void>((resolve) => gate.waiters.push(resolve));
  }
  gate.active++;
  try {
    return await run();
  } finally {
    gate.active--;
    const next = gate.waiters.shift();
    if (next) next();
  }
}

/* ---------------------------------------------------- URL validation --- */

const PRIVATE_V4 =
  /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Recover the IPv4 address an IPv4-mapped or IPv4-compatible IPv6 address
 * carries, as a dotted quad.
 *
 * `new URL("http://[::ffff:127.0.0.1]/")` canonicalises to `[::ffff:7f00:1]`,
 * so checking only the dotted form leaves loopback reachable through the
 * bracketed one. Both the compressed (`::ffff:7f00:1`) and the fully expanded
 * (`0:0:0:0:0:ffff:7f00:1`) spellings are decoded. A normal public IPv6
 * address has non-zero groups before the tail and is not touched, so
 * `2001:4860:4860::8888` is not mistaken for a private IPv4 tail.
 */
function embeddedIpv4(host: string): string | null {
  const dotted = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
  if (dotted) return dotted[1]!;

  const [head = "", tail = ""] = host.split("::");
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;

  const prefix = groups.slice(0, 6);
  const mapped = prefix.slice(0, 5).every((g) => g === "0") && prefix[5] === "ffff";
  const compatible = prefix.every((g) => g === "0");
  if (!mapped && !compatible) return null;

  const hi = Number.parseInt(groups[6]!, 16);
  const lo = Number.parseInt(groups[7]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Loopback, RFC1918, link-local, CGNAT, IPv4-mapped and the obvious internal names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  const embedded = embeddedIpv4(host);
  if (embedded) return isPrivateHost(embedded);
  if (isIP(host) === 4) return PRIVATE_V4.test(host);
  if (isIP(host) === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      /^fe[89a-f]/.test(host) || // link-local fe80::/10 and deprecated site-local fec0::/10
      /^f[cd]/.test(host) // unique-local fc00::/7
    );
  }
  return false;
}

function validateTarget(
  url: URL,
  initialHost: string,
  allowHost: HttpOptions["allowHost"],
  phase: "request" | "redirect",
): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(`${phase} target ${url.href} is not HTTP(S)`, "redirect");
  }
  if (url.username || url.password) {
    throw new HttpError(`${phase} target ${url.href} carries credentials`, "redirect");
  }
  if (isPrivateHost(url.hostname)) {
    throw new HttpError(`${phase} target ${url.hostname} is private or link-local`, "redirect");
  }
  if (phase === "redirect" && url.hostname !== initialHost && !allowHost?.(url.hostname, initialHost)) {
    throw new HttpError(
      `redirect to ${url.hostname} is not on the allowlist for ${initialHost}`,
      "redirect",
    );
  }
}

/* ------------------------------------------------------------ fetch --- */

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new HttpError(
      `${url}: content-length ${declared} exceeds the ${maxBytes} byte cap`,
      "oversized",
      { status: res.status },
    );
  }

  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(`${url}: body exceeds the ${maxBytes} byte cap`, "oversized", {
          status: res.status,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function finish(res: Response, url: string, maxBytes: number, options: HttpOptions): Promise<HttpResponse> {
  const etag = res.headers.get("etag") ?? options.etag ?? null;
  const lastModified = res.headers.get("last-modified") ?? options.lastModified ?? null;
  const contentType = res.headers.get("content-type");
  const base = { status: res.status, etag, lastModified, finalUrl: url, contentType };

  if (res.status === 304) {
    await res.body?.cancel();
    return { ...base, body: null };
  }

  if (res.status === 403 || res.status === 429) {
    const retry = retryAfterMs(res);
    await res.body?.cancel();
    throw new HttpError(`${url} -> HTTP ${res.status} ${res.statusText}`, "blocked", {
      status: res.status,
      retryAfterMs: retry,
    });
  }

  if (!res.ok) {
    const retry = retryAfterMs(res);
    await res.body?.cancel();
    throw new HttpError(`${url} -> HTTP ${res.status} ${res.statusText}`, "http", {
      status: res.status,
      retryAfterMs: retry,
    });
  }

  return { ...base, body: await readCapped(res, maxBytes, url) };
}

/** One GET, following redirects by hand so every hop can be validated. */
async function fetchFollow(
  start: URL,
  options: HttpOptions,
  maxBytes: number,
): Promise<HttpResponse> {
  const initialHost = start.hostname;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = {
      "user-agent": "eve",
      ...(options.accept ? { accept: options.accept } : {}),
      ...(options.etag ? { "if-none-match": options.etag } : {}),
      ...(options.lastModified ? { "if-modified-since": options.lastModified } : {}),
      ...options.headers,
    };

    const res = await fetch(current, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(timeout),
    }).catch((e: unknown) => {
      const message =
        e instanceof Error && e.name === "TimeoutError"
          ? `${current.href}: timed out after ${timeout}ms`
          : `${current.href}: ${e instanceof Error ? e.message : String(e)}`;
      throw new HttpError(message, "network", { cause: e });
    });

    if (REDIRECT_STATUS.has(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) {
        throw new HttpError(`${current.href} -> redirect without a Location header`, "redirect", {
          status: res.status,
        });
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new HttpError(`${current.href} -> unparseable redirect ${location}`, "redirect", {
          status: res.status,
        });
      }
      validateTarget(next, initialHost, options.allowHost, "redirect");
      current = next;
      continue;
    }

    return await finish(res, current.href, maxBytes, options);
  }

  throw new HttpError(`${start.href}: more than ${MAX_REDIRECTS} redirects`, "redirect");
}

function retryDelay(error: unknown, attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  if (!(error instanceof HttpError)) return null;
  if (error.kind === "network" || (error.kind === "http" && (error.status ?? 0) >= 500)) {
    // Jittered, because a dozen sources recovering from the same blip should
    // not come back in lockstep.
    return 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
  }
  if (error.kind === "blocked" && error.retryAfterMs !== null && error.retryAfterMs <= RETRY_BLOCK_MS) {
    return error.retryAfterMs;
  }
  return null;
}

/**
 * Bounded GET returning decoded text. Throws `HttpError` for every failure
 * mode — a 304 is a normal return with `body: null`, not an error.
 */
export async function request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
  const start = new URL(url);
  validateTarget(start, start.hostname, options.allowHost, "request");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return withHostSlot(start.hostname, options.perHost ?? 2, async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fetchFollow(start, options, maxBytes);
      } catch (e) {
        lastError = e;
        const wait = retryDelay(e, attempt);
        if (wait === null) throw e;
        await delay(wait);
      }
    }
    throw lastError;
  });
}

/**
 * `request` plus the JSON checks. HTML at a JSON endpoint is the single most
 * common way a blocked source masquerades as an empty one, so it throws here
 * rather than letting `JSON.parse` fail with a syntax error nobody reads.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: HttpOptions = {},
): Promise<{ status: number; body: T | null; etag: string | null; lastModified: string | null }> {
  const res = await request(url, { accept: "application/json", ...options });
  if (res.body === null) {
    return { status: res.status, body: null, etag: res.etag, lastModified: res.lastModified };
  }
  if (res.contentType && !/json/i.test(res.contentType)) {
    throw new HttpError(`${url}: expected JSON, got ${res.contentType}`, "malformed", {
      status: res.status,
    });
  }
  try {
    return {
      status: res.status,
      body: JSON.parse(res.body) as T,
      etag: res.etag,
      lastModified: res.lastModified,
    };
  } catch (e) {
    throw new HttpError(`${url}: response is not valid JSON`, "malformed", {
      status: res.status,
      cause: e,
    });
  }
}
