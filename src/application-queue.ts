import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type ApplicationState = 'queued' | 'running' | 'repair' | 'handoff' | 'uncertain' | 'submitted' | 'cancelled' | 'failed';
export interface ApplicationJob {
  id: number; posting_id: number; identity: string; state: ApplicationState;
  destination: string; attempts: number; repairs: number;
  lease_token: string | null; lease_until: string | null;
  result_json: string | null; last_error: string | null;
  created_at: string; updated_at: string;
}
export interface QueueOptions { destination: string; limit: number; }
export interface FinishResult {
  state: Exclude<ApplicationState, 'queued' | 'running'>;
  result?: unknown; error?: string;
}

// Bound each operation and stored payload without deleting audit or dedupe history.
const MAX_BATCH = 1000;
const MAX_LEASE_SECONDS = 86400;
const ELIGIBLE = `p.state = 'open' AND p.applied_at IS NULL
  AND (p.closes_at IS NULL OR julianday(p.closes_at) > julianday('now'))
  AND NOT EXISTS (SELECT 1 FROM postings applied WHERE applied.key = p.key AND applied.applied_at IS NOT NULL)`;

function boundedInteger(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`Expected an integer between 1 and ${max}`);
  }
  return value;
}

function json(payload: unknown): string {
  const value = JSON.stringify(payload);
  if (value === undefined || Buffer.byteLength(value) > 65536) {
    throw new RangeError('Application payload must be JSON of at most 65536 bytes');
  }
  return value;
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function event(db: DatabaseSync, id: number, kind: string, payload: string): void {
  const inserted = db.prepare('INSERT INTO application_events (job_id, kind, payload_json) VALUES (?, ?, ?)')
    .run(id, kind, payload);
  if (kind === 'handoff' || kind === 'uncertain' || kind === 'failed') {
    db.prepare('INSERT INTO application_notifications (event_id) VALUES (?)').run(inserted.lastInsertRowid);
  }
}

function recover(db: DatabaseSync): number {
  const expired = db.prepare(`UPDATE application_jobs
    SET state = 'uncertain', lease_token = NULL, lease_until = NULL,
      last_error = 'Browser lease expired; submission requires reconciliation', updated_at = datetime('now')
    WHERE state = 'running' AND (julianday(lease_until) IS NULL OR julianday(lease_until) <= julianday('now'))
    RETURNING id`).all();
  for (const row of expired) event(db, Number(row.id), 'uncertain', json({ error: 'Browser lease expired; submission requires reconciliation' }));
  return expired.length;
}

export function enqueueApplications(db: DatabaseSync, options: QueueOptions): number {
  boundedInteger(options.limit, MAX_BATCH);
  if (typeof options.destination !== 'string' || options.destination.trim().length === 0 || options.destination.length > 2048) {
    throw new RangeError('Application destination must contain 1 to 2048 characters');
  }
  return transaction(db, () => {
    const rows = db.prepare(`INSERT INTO application_jobs (posting_id, identity, destination)
      SELECT MIN(p.id), p.key, ? FROM postings p WHERE ${ELIGIBLE}
        AND NOT EXISTS (SELECT 1 FROM application_jobs j WHERE j.identity = p.key AND j.destination = ?)
      GROUP BY p.key ORDER BY MIN(p.id) LIMIT ? RETURNING id`)
      .all(options.destination, options.destination, options.limit);
    for (const row of rows) event(db, Number(row.id), 'queued', json({ destination: options.destination }));
    return rows.length;
  });
}

export function claimApplication(db: DatabaseSync, leaseSeconds: number): ApplicationJob | undefined {
  boundedInteger(leaseSeconds, MAX_LEASE_SECONDS);
  return transaction(db, () => {
    recover(db);
    if (db.prepare("SELECT id FROM application_jobs WHERE state = 'running'").get()) return undefined;
    const queued = db.prepare("SELECT * FROM application_jobs WHERE state = 'queued' ORDER BY id LIMIT ?")
      .all(MAX_BATCH) as unknown as ApplicationJob[];
    for (const job of queued) {
      const posting = db.prepare(`SELECT p.id FROM postings p WHERE p.key = ? AND ${ELIGIBLE}
        ORDER BY (p.id = ?) DESC, p.id LIMIT 1`).get(job.identity, job.posting_id);
      if (!posting) {
        db.prepare(`UPDATE application_jobs SET state = 'cancelled',
          last_error = 'Posting is no longer eligible', updated_at = datetime('now') WHERE id = ?`).run(job.id);
        event(db, job.id, 'cancelled', json({ error: 'Posting is no longer eligible' }));
        continue;
      }
      const token = randomUUID();
      const claimed = db.prepare(`UPDATE application_jobs SET posting_id = ?, state = 'running', attempts = attempts + 1,
        lease_token = ?, lease_until = datetime('now', ?), updated_at = datetime('now')
        WHERE id = ? AND state = 'queued' RETURNING *`)
        .get(posting.id, token, `+${leaseSeconds} seconds`, job.id) as unknown as ApplicationJob;
      event(db, job.id, 'running', json({ attempt: claimed.attempts }));
      return claimed;
    }
    return undefined;
  });
}

export function renewApplication(db: DatabaseSync, id: number, token: string, leaseSeconds: number): boolean {
  boundedInteger(leaseSeconds, MAX_LEASE_SECONDS);
  return transaction(db, () => {
    recover(db);
    return db.prepare(`UPDATE application_jobs SET lease_until = datetime('now', ?), updated_at = datetime('now')
      WHERE id = ? AND state = 'running' AND lease_token = ? AND julianday(lease_until) > julianday('now')`)
      .run(`+${leaseSeconds} seconds`, id, token).changes > 0;
  });
}

export function finishApplication(db: DatabaseSync, id: number, token: string, result: FinishResult): boolean {
  if (!['repair', 'handoff', 'uncertain', 'submitted', 'cancelled', 'failed'].includes(result.state)) {
    throw new RangeError('Invalid application outcome');
  }
  if (result.error !== undefined && (typeof result.error !== 'string' || result.error.length > 4096)) {
    throw new RangeError('Application error exceeds 4096 characters');
  }
  const storedResult = result.result === undefined ? null : json(result.result);
  const payload = json(result);
  return transaction(db, () => {
    recover(db);
    const changed = db.prepare(`UPDATE application_jobs SET state = ?, result_json = ?, last_error = ?,
      repairs = repairs + ?, lease_token = NULL, lease_until = NULL, updated_at = datetime('now')
      WHERE id = ? AND state = 'running' AND lease_token = ? AND julianday(lease_until) > julianday('now')`)
      .run(result.state, storedResult, result.error ?? null, Number(result.state === 'repair'), id, token).changes > 0;
    if (changed) event(db, id, result.state, payload);
    return changed;
  });
}

export function recoverApplications(db: DatabaseSync): number {
  return transaction(db, () => recover(db));
}

export function resumeApplication(db: DatabaseSync, id: number): boolean {
  return transaction(db, () => {
    const changed = db.prepare(`UPDATE application_jobs SET state = 'queued', updated_at = datetime('now')
      WHERE id = ? AND state IN ('handoff', 'failed', 'repair')`).run(id).changes > 0;
    if (changed) event(db, id, 'resumed', '{}');
    return changed;
  });
}

export function listApplications(db: DatabaseSync, limit = 100): ApplicationJob[] {
  return db.prepare('SELECT * FROM application_jobs ORDER BY id DESC LIMIT ?')
    .all(boundedInteger(limit, MAX_BATCH)) as unknown as ApplicationJob[];
}

export function recordApplicationEvent(db: DatabaseSync, id: number, kind: string, payload: unknown): void {
  if (typeof kind !== 'string' || kind.trim().length === 0 || kind.length > 128) {
    throw new RangeError('Application event kind must contain 1 to 128 characters');
  }
  const stored = json(payload);
  transaction(db, () => event(db, id, kind, stored));
}

export function pendingApplicationNotifications(db: DatabaseSync, limit = 100): Array<{ id: number; job_id: number; payload_json: string }> {
  return db.prepare(`SELECT e.id, e.job_id, e.payload_json FROM application_events e
    JOIN application_notifications n ON n.event_id = e.id WHERE n.delivered_at IS NULL ORDER BY e.id LIMIT ?`)
    .all(boundedInteger(limit, MAX_BATCH)) as Array<{ id: number; job_id: number; payload_json: string }>;
}

export function acknowledgeApplicationNotification(db: DatabaseSync, eventId: number): void {
  db.prepare(`UPDATE application_notifications SET delivered_at = datetime('now')
    WHERE event_id = ? AND delivered_at IS NULL`).run(eventId);
}
