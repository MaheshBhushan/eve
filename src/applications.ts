import { closeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { loadApplicationConfig, requireApplicationExecution, type ApplicationConfig } from "./application-config.ts";
import {
  acknowledgeApplicationNotification, claimApplication, enqueueApplications, finishApplication,
  listApplications, pendingApplicationNotifications, recoverApplications, resumeApplication,
  type FinishResult,
} from "./application-queue.ts";
import { acquireApplicationLock, runApplication } from "./application-runner.ts";
import { getPosting, openDb } from "./db.ts";

type Notification = { id: number; job_id: number; payload_json: string };

export async function deliverApplicationNotification(config: ApplicationConfig, notification: Notification, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
  const discord = Boolean(config.discordChannelId);
  const token = discord ? config.discordToken : config.telegramToken;
  if (!token || (!discord && !config.telegramChatId)) throw new Error("Application notification transport is not configured");
  const text = `Eve application needs attention — job ${notification.job_id} (event ${notification.id})\n${notification.payload_json}`
    .replaceAll(token, "[redacted]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, discord ? 1900 : 3500);
  const timeout = AbortSignal.timeout((discord ? config.discordTimeoutSeconds : config.telegramTimeoutSeconds) * 1000);
  try {
    const response = await transport(discord
      ? `https://discord.com/api/v10/channels/${config.discordChannelId}/messages`
      : `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: "POST",
      headers: discord ? { "content-type": "application/json", authorization: `Bot ${token}` } : { "content-type": "application/json" },
      body: JSON.stringify(discord
        ? { content: text, allowed_mentions: { parse: [] } }
        : { chat_id: config.telegramChatId, text }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error("Notification HTTP response failed");
    const body = await response.json() as { ok?: unknown; id?: unknown; channel_id?: unknown };
    if (discord
      ? typeof body?.id !== "string" || !/^\d{17,20}$/.test(body.id) || body.channel_id !== config.discordChannelId
      : body?.ok !== true) throw new Error("Notification delivery was not acknowledged");
  } catch {
    // Transport failures can include secret request headers or URLs.
    throw new Error("Notification delivery failed or timed out; notification remains pending");
  }
}

export async function drainApplicationNotifications(db: DatabaseSync, config: ApplicationConfig, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<{ delivered: number; pending: boolean }> {
  let delivered = 0;
  const notifications = pendingApplicationNotifications(db, 100);
  if (config.discordChannelId ? !config.discordToken : !config.telegramToken || !config.telegramChatId) return { delivered, pending: notifications.length > 0 };
  for (const notification of notifications) {
    if (signal?.aborted) return { delivered, pending: true };
    try {
      await deliverApplicationNotification(config, notification, transport, signal);
      acknowledgeApplicationNotification(db, notification.id);
      delivered++;
    } catch {
      // One transport outage must not delay the application backlog by N timeouts.
      return { delivered, pending: true };
    }
  }
  return { delivered, pending: pendingApplicationNotifications(db, 1).length > 0 };
}

export async function runApplicationCycle(db: DatabaseSync, config: ApplicationConfig, signal?: AbortSignal, transport: typeof fetch = fetch) {
  requireApplicationExecution(config);
  const lockFd = acquireApplicationLock(config);
  if (lockFd === undefined) return { busy: true, enqueued: 0, recovered: 0, jobs: [], notifications: { delivered: 0, pending: true } };
  try {
    const enqueued = enqueueApplications(db, { destination: config.destination, limit: config.enqueueLimit });
    const recovered = recoverApplications(db);
    const notifications = await drainApplicationNotifications(db, config, transport, signal);
    const jobs: Array<{ id: number; state: string; ownershipLost: boolean }> = [];
    for (let count = 0; count < config.maxJobs && !signal?.aborted; count++) {
      const job = claimApplication(db, config.leaseSeconds);
      if (!job) break;
      let result: FinishResult;
      try {
        const posting = getPosting(db, job.posting_id);
        result = posting ? await runApplication(db, config, job, posting, lockFd, signal) :
          { state: "cancelled", error: "Source posting no longer exists" };
      } catch {
        result = { state: "uncertain", error: "Application controller failed; reconcile local run evidence before retry" };
      }
      const finished = finishApplication(db, job.id, job.lease_token!, result);
      jobs.push({ id: job.id, state: finished ? result.state : "uncertain", ownershipLost: !finished });
      // Retry delivery once per cycle after processing, rather than per failed job.
    }
    const drained = await drainApplicationNotifications(db, config, transport, signal);
    return { busy: false, enqueued, recovered, jobs, notifications: { delivered: notifications.delivered + drained.delivered, pending: drained.pending } };
  } finally { closeSync(lockFd); }
}

export async function applicationsMain(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const command = args[0] ?? "status";
  if (command === "--help" || command === "help") {
    console.log("Usage: node src/applications.ts enqueue|run|status|resume <id>\nrun: backfill, reconcile expired ownership, deliver pending notifications, process bounded sequential test applications.\nresume: explicitly requeue a resolved handoff/failed/repair job; uncertain submissions require reconciliation.");
    return 0;
  }
  if (!["enqueue", "run", "status", "resume"].includes(command) ||
      (command === "resume" ? args.length !== 2 || !/^[1-9]\d*$/.test(args[1]!) || !Number.isSafeInteger(Number(args[1])) : args.length > 1)) {
    throw new Error("Usage: node src/applications.ts enqueue|run|status|resume <id>");
  }
  const config = loadApplicationConfig(env);
  if (command !== "status" && !config.enabled) {
    console.log(JSON.stringify({ command, enabled: false, message: "Application execution is disabled" }));
    return command === "resume" ? 1 : 0;
  }
  if (command !== "status") requireApplicationExecution(config);
  process.umask(0o077);
  const db = openDb(config.dbPath);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    if (command === "status") {
      console.log(JSON.stringify({ enabled: config.enabled, destination: config.destination || null, jobs: listApplications(db, 100), pendingNotifications: pendingApplicationNotifications(db, 100).length }, null, 2));
    } else if (command === "run") {
      console.log(JSON.stringify(await runApplicationCycle(db, config, abort.signal)));
    } else {
      const lockFd = acquireApplicationLock(config);
      if (lockFd === undefined) { console.log(JSON.stringify({ busy: true })); return 1; }
      try {
        if (command === "enqueue") console.log(JSON.stringify({ enqueued: enqueueApplications(db, { destination: config.destination, limit: config.enqueueLimit }) }));
        else {
          const resumed = resumeApplication(db, Number(args[1]));
          console.log(JSON.stringify({ id: Number(args[1]), resumed }));
          if (!resumed) return 1;
        }
      } finally { closeSync(lockFd); }
    }
    return abort.signal.aborted ? 130 : 0;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    db.close();
  }
}

if (import.meta.filename === process.argv[1]) {
  applicationsMain().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[applications] ${error instanceof Error ? error.message : "Controller failed"}`);
    process.exitCode = 1;
  });
}
