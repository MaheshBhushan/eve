import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  acknowledgeApplicationNotification, claimApplication, enqueueApplications,
  finishApplication, listApplications, pendingApplicationNotifications,
  recordApplicationEvent, recoverApplications, renewApplication, resumeApplication,
} from './application-queue.ts';
import type { ApplicationState } from './application-queue.ts';

const destination = 'https://review.example.test/apply';
const options = { destination, limit: 100 };

function posting(db: DatabaseSync, key = 'role', source = 'board'): number {
  db.prepare("INSERT OR IGNORE INTO sources (kind, ident, label) VALUES ('greenhouse', ?, ?)").run(source, source);
  const sourceId = Number(db.prepare('SELECT id FROM sources WHERE ident = ?').get(source)!.id);
  return Number(db.prepare(`INSERT INTO postings
    (source_id, key, external_id, title, company, url, posted_at)
    VALUES (?, ?, ?, 'Engineer', 'Acme', 'https://jobs.example.test/role', datetime('now'))`)
    .run(sourceId, key, key).lastInsertRowid);
}

function expire(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE application_jobs SET lease_until = datetime('now', '-1 second') WHERE id = ?").run(id);
}

test('backfill deduplicates cross-source identities per exact destination without losing limit slots', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db, 'same', 'one'); posting(db, 'same', 'two'); posting(db, 'other');
  assert.equal(enqueueApplications(db, { destination, limit: 1 }), 1);
  assert.equal(enqueueApplications(db, { destination, limit: 1 }), 1);
  assert.equal(enqueueApplications(db, options), 0);
  assert.equal(enqueueApplications(db, { destination: `${destination}/second`, limit: 100 }), 2);
  assert.equal(listApplications(db).length, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE kind = 'queued'").get()!.n, 4);
});

test('enqueue excludes closed, applied, expired, invalid-deadline and cross-source applied identities', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  const closed = posting(db, 'closed');
  const applied = posting(db, 'applied');
  const expired = posting(db, 'expired');
  const invalid = posting(db, 'invalid');
  const boundary = posting(db, 'boundary');
  posting(db, 'applied', 'copy');
  db.prepare("UPDATE postings SET state = 'closed' WHERE id = ?").run(closed);
  db.prepare("UPDATE postings SET applied_at = datetime('now') WHERE id = ?").run(applied);
  db.prepare("UPDATE postings SET closes_at = datetime('now', '-1 day') WHERE id = ?").run(expired);
  db.prepare("UPDATE postings SET closes_at = 'not a date' WHERE id = ?").run(invalid);
  db.prepare("UPDATE postings SET closes_at = datetime('now') WHERE id = ?").run(boundary);
  const future = posting(db, 'future');
  db.prepare("UPDATE postings SET closes_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day') WHERE id = ?").run(future);
  assert.equal(enqueueApplications(db, options), 1);
  assert.equal(listApplications(db)[0]!.posting_id, future);
});

for (const change of ['closed', 'applied', 'expired', 'deleted', 'copy applied'] as const) {
  test(`claim rechecks ${change} after enqueue and appends cancellation`, t => {
    const db = openDb(':memory:'); t.after(() => db.close());
    const id = posting(db);
    enqueueApplications(db, options);
    if (change === 'closed') db.prepare("UPDATE postings SET state = 'closed' WHERE id = ?").run(id);
    if (change === 'applied') db.prepare("UPDATE postings SET applied_at = datetime('now') WHERE id = ?").run(id);
    if (change === 'expired') db.prepare("UPDATE postings SET closes_at = datetime('now', '-1 day') WHERE id = ?").run(id);
    if (change === 'deleted') db.prepare('DELETE FROM sources').run();
    if (change === 'copy applied') {
      const copy = posting(db, 'role', 'copy');
      db.prepare("UPDATE postings SET applied_at = datetime('now') WHERE id = ?").run(copy);
    }
    assert.equal(claimApplication(db, 60), undefined);
    const job = listApplications(db)[0]!;
    assert.equal(job.state, 'cancelled');
    assert.equal(job.attempts, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE kind = 'cancelled'").get()!.n, 1);
  });
}

test('claim can use a surviving eligible source copy while preserving identity', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  const original = posting(db, 'same', 'original');
  enqueueApplications(db, options);
  const copy = posting(db, 'same', 'copy');
  db.prepare('DELETE FROM postings WHERE id = ?').run(original);
  const claimed = claimApplication(db, 60)!;
  assert.equal(claimed.posting_id, copy);
  assert.equal(claimed.identity, 'same');
});

test('claims are globally exclusive across connections and destinations, with token fencing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-app-queue-'));
  const path = join(dir, 'queue.db');
  const db = openDb(path); const other = openDb(path);
  t.after(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  posting(db);
  enqueueApplications(db, options);
  enqueueApplications(db, { destination: `${destination}/second`, limit: 100 });
  const first = claimApplication(db, 60)!;
  assert.equal(first.attempts, 1);
  assert.ok(first.lease_token);
  assert.equal(claimApplication(other, 60), undefined);
  assert.equal(renewApplication(other, first.id, 'wrong', 60), false);
  assert.equal(finishApplication(other, first.id, 'wrong', { state: 'submitted' }), false);
  assert.equal(renewApplication(other, first.id, first.lease_token!, 120), true);
  assert.equal(finishApplication(db, first.id, first.lease_token!, { state: 'handoff' }), true);
  const second = claimApplication(other, 60)!;
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.lease_token, first.lease_token);
  assert.equal(finishApplication(db, first.id, first.lease_token!, { state: 'submitted' }), false);
});

test('simultaneous controller processes obtain only one browser lease', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-app-race-'));
  const path = join(dir, 'queue.db');
  const db = openDb(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  posting(db, 'one'); posting(db, 'two');
  enqueueApplications(db, options);
  const script = `
    const { openDb } = await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)});
    const { claimApplication } = await import(${JSON.stringify(new URL('./application-queue.ts', import.meta.url).href)});
    const db = openDb(process.argv[1]);
    try { console.log(JSON.stringify(claimApplication(db, 60)?.id ?? null)); }
    finally { db.close(); }
  `;
  const run = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, path], { timeout: 15000 });
  const results = await Promise.all([run(), run()]);
  const claims = results.map(result => JSON.parse(result.stdout.trim()) as number | null);
  assert.equal(claims.filter(id => id !== null).length, 1);
  assert.equal(listApplications(db).filter(job => job.state === 'running').length, 1);
});

test('claim reconciles expired ownership before granting a new lease and queues uncertainty notification once', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db, 'one'); posting(db, 'two'); enqueueApplications(db, options);
  const first = claimApplication(db, 60)!;
  expire(db, first.id);
  const second = claimApplication(db, 60)!;
  assert.notEqual(second.id, first.id);
  const expired = listApplications(db).find(job => job.id === first.id)!;
  assert.equal(expired.state, 'uncertain');
  assert.equal(expired.lease_token, null);
  assert.equal(expired.lease_until, null);
  assert.equal(renewApplication(db, first.id, first.lease_token!, 60), false);
  assert.equal(finishApplication(db, first.id, first.lease_token!, { state: 'submitted' }), false);
  assert.equal(resumeApplication(db, first.id), false);
  assert.equal(recoverApplications(db), 0);
  assert.equal(pendingApplicationNotifications(db).length, 1);
  const events = db.prepare('SELECT job_id, kind FROM application_events ORDER BY id').all();
  const uncertainIndex = events.findIndex(event => event.kind === 'uncertain');
  const nextClaimIndex = events.findIndex(event => event.kind === 'running' && event.job_id === second.id);
  assert.ok(uncertainIndex < nextClaimIndex);
});

for (const operation of ['recover', 'renew', 'finish'] as const) {
  test(`${operation} cannot revive an expired lease`, t => {
    const db = openDb(':memory:'); t.after(() => db.close());
    posting(db); enqueueApplications(db, options);
    const job = claimApplication(db, 60)!; expire(db, job.id);
    if (operation === 'recover') assert.equal(recoverApplications(db), 1);
    if (operation === 'renew') assert.equal(renewApplication(db, job.id, job.lease_token!, 60), false);
    if (operation === 'finish') assert.equal(finishApplication(db, job.id, job.lease_token!, { state: 'submitted' }), false);
    assert.equal(listApplications(db)[0]!.state, 'uncertain');
    assert.equal(recoverApplications(db), 0);
    assert.equal(pendingApplicationNotifications(db).length, 1);
  });
}

for (const state of ['repair', 'handoff', 'uncertain', 'submitted', 'cancelled', 'failed'] as const) {
  test(`${state} is retained by backfill; only explicit resumable states requeue`, t => {
    const db = openDb(':memory:'); t.after(() => db.close());
    posting(db); enqueueApplications(db, options);
    const job = claimApplication(db, 60)!;
    assert.equal(finishApplication(db, job.id, job.lease_token!, { state, result: { evidence: ['local'] }, error: 'details' }), true);
    assert.equal(enqueueApplications(db, options), 0);
    assert.equal(claimApplication(db, 60), undefined);
    const finished = listApplications(db)[0]!;
    assert.equal(finished.state, state);
    assert.equal(finished.repairs, state === 'repair' ? 1 : 0);
    assert.deepEqual(JSON.parse(finished.result_json!), { evidence: ['local'] });
    assert.equal(finished.last_error, 'details');
    assert.equal(db.prepare('SELECT applied_at FROM postings').get()!.applied_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n, 0);
    const resumable = ['repair', 'handoff', 'failed'].includes(state);
    assert.equal(resumeApplication(db, job.id), resumable);
    assert.equal(resumeApplication(db, job.id), false);
    if (resumable) {
      const retry = claimApplication(db, 60)!;
      assert.equal(retry.attempts, 2);
      assert.equal(retry.repairs, finished.repairs);
      assert.notEqual(retry.lease_token, job.lease_token);
      assert.equal(finishApplication(db, retry.id, job.lease_token!, { state: 'submitted' }), false);
    }
    assert.equal(pendingApplicationNotifications(db).length, ['handoff', 'uncertain', 'failed'].includes(state) ? 1 : 0);
  });
}

test('resume does not bypass posting eligibility or reset counters and result history', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  const id = posting(db); enqueueApplications(db, options);
  const job = claimApplication(db, 60)!;
  finishApplication(db, job.id, job.lease_token!, { state: 'failed', error: 'preflight failed' });
  db.prepare("UPDATE postings SET state = 'closed' WHERE id = ?").run(id);
  assert.equal(resumeApplication(db, job.id), true);
  assert.equal(claimApplication(db, 60), undefined);
  assert.equal(listApplications(db)[0]!.state, 'cancelled');
  assert.equal(listApplications(db)[0]!.attempts, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE kind = 'failed'").get()!.n, 1);
});

test('outcome and notification insertion roll back together on audit failure', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db); enqueueApplications(db, options);
  const job = claimApplication(db, 60)!;
  db.exec(`CREATE TRIGGER reject_notification BEFORE INSERT ON application_notifications
    BEGIN SELECT RAISE(ABORT, 'delivery storage unavailable'); END`);
  assert.throws(() => finishApplication(db, job.id, job.lease_token!, { state: 'handoff' }), /delivery storage unavailable/);
  assert.equal(listApplications(db)[0]!.state, 'running');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE kind = 'handoff'").get()!.n, 0);
  db.exec('DROP TRIGGER reject_notification');
  assert.equal(finishApplication(db, job.id, job.lease_token!, { state: 'handoff' }), true);
  assert.equal(pendingApplicationNotifications(db).length, 1);
});

test('a failed expired-lease notification blocks a new claim and rolls recovery back', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db, 'one'); posting(db, 'two'); enqueueApplications(db, options);
  const job = claimApplication(db, 60)!; expire(db, job.id);
  db.exec(`CREATE TRIGGER reject_notification BEFORE INSERT ON application_notifications
    BEGIN SELECT RAISE(ABORT, 'delivery storage unavailable'); END`);
  assert.throws(() => claimApplication(db, 60), /delivery storage unavailable/);
  assert.equal(listApplications(db).filter(row => row.state === 'running').length, 1);
  assert.equal(listApplications(db).filter(row => row.state === 'queued').length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM application_events WHERE kind = 'uncertain'").get()!.n, 0);
});

test('pending notifications survive reopen and source deletion; acknowledgement preserves audit', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-app-notification-'));
  const path = join(dir, 'queue.db');
  let db = openDb(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  posting(db); enqueueApplications(db, options);
  const job = claimApplication(db, 60)!;
  finishApplication(db, job.id, job.lease_token!, { state: 'failed', error: 'runtime missing' });
  recordApplicationEvent(db, job.id, 'handoff', { reason: 'operator fact required' });
  const pending = pendingApplicationNotifications(db);
  assert.equal(pending.length, 2);
  // A failed transport makes no acknowledgement; reading must never consume it.
  assert.deepEqual(pendingApplicationNotifications(db), pending);
  db.prepare('DELETE FROM sources').run();
  db.close(); db = openDb(path);
  assert.deepEqual(pendingApplicationNotifications(db), pending);
  assert.equal(listApplications(db)[0]!.posting_id, job.posting_id);
  const history = db.prepare('SELECT * FROM application_events ORDER BY id').all();
  acknowledgeApplicationNotification(db, pending[0]!.id);
  acknowledgeApplicationNotification(db, pending[0]!.id);
  assert.deepEqual(pendingApplicationNotifications(db), pending.slice(1));
  assert.deepEqual(db.prepare('SELECT * FROM application_events ORDER BY id').all(), history);
  assert.throws(() => db.prepare("UPDATE application_events SET payload_json = '{}' WHERE id = ?").run(pending[0]!.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM application_events WHERE id = ?').run(pending[0]!.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM application_jobs WHERE id = ?').run(job.id), /FOREIGN KEY/);
});

test('invalid bounds and oversized payloads fail without queue or audit writes', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
    assert.throws(() => enqueueApplications(db, { destination, limit }), RangeError);
    assert.throws(() => listApplications(db, limit), RangeError);
    assert.throws(() => pendingApplicationNotifications(db, limit), RangeError);
  }
  for (const lease of [0, -1, 1.5, NaN, Infinity, 86401]) {
    assert.throws(() => claimApplication(db, lease), RangeError);
    assert.throws(() => renewApplication(db, 1, 'token', lease), RangeError);
  }
  for (const value of ['', ' ', 'x'.repeat(2049)]) assert.throws(() => enqueueApplications(db, { destination: value, limit: 1 }), RangeError);
  assert.equal(listApplications(db).length, 0);
  enqueueApplications(db, options);
  const job = claimApplication(db, 60)!;
  const before = db.prepare('SELECT COUNT(*) AS n FROM application_events').get()!.n;
  for (const payload of [undefined, 'x'.repeat(65536), '😀'.repeat(20000)]) {
    assert.throws(() => recordApplicationEvent(db, job.id, 'failure', payload), RangeError);
  }
  assert.throws(() => recordApplicationEvent(db, job.id, '', {}), RangeError);
  assert.throws(() => recordApplicationEvent(db, job.id, 'x'.repeat(129), {}), RangeError);
  assert.throws(() => recordApplicationEvent(db, 9999, 'note', {}), /FOREIGN KEY/);
  assert.throws(() => finishApplication(db, job.id, job.lease_token!, { state: 'failed', error: 'x'.repeat(4097) }), RangeError);
  assert.throws(() => finishApplication(db, job.id, job.lease_token!, { state: 'queued' as Exclude<ApplicationState, 'queued' | 'running'> }), RangeError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM application_events').get()!.n, before);
  assert.equal(listApplications(db)[0]!.state, 'running');
});

test('database constraints reject simultaneous browser owners and invalid lease shapes', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db, 'one'); posting(db, 'two'); enqueueApplications(db, options);
  const job = claimApplication(db, 60)!;
  const queued = listApplications(db).find(row => row.state === 'queued')!;
  assert.throws(() => db.prepare(`UPDATE application_jobs SET state = 'running',
    lease_token = 'other', lease_until = datetime('now', '+60 seconds') WHERE id = ?`).run(queued.id), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE application_jobs SET lease_token = NULL WHERE id = ?").run(job.id), /CHECK/);
  assert.throws(() => db.prepare("UPDATE application_jobs SET lease_token = 'orphan' WHERE id = ?").run(queued.id), /CHECK/);
  assert.equal(listApplications(db).filter(row => row.state === 'running').length, 1);
});

test('backfill and its audit are atomic when event storage fails', t => {
  const db = openDb(':memory:'); t.after(() => db.close());
  posting(db, 'one'); posting(db, 'two');
  db.exec(`CREATE TRIGGER reject_queued_event BEFORE INSERT ON application_events
    WHEN NEW.kind = 'queued' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  assert.throws(() => enqueueApplications(db, options), /audit unavailable/);
  assert.equal(listApplications(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM application_events').get()!.n, 0);
  db.exec('DROP TRIGGER reject_queued_event');
  assert.equal(enqueueApplications(db, options), 2);
});
