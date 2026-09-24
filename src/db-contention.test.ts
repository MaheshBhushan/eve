import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, markDelivered } from './db.ts';

test('an up-to-date database opens and reads while another process holds the writer lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-contention-'));
  const path = join(dir, 'test.db');
  const writer = openDb(path);
  let reader: ReturnType<typeof openDb> | undefined;
  try {
    writer.exec('BEGIN IMMEDIATE');
    reader = openDb(path, 100);
    assert.equal(reader.prepare('PRAGMA busy_timeout').get()!.timeout, 100);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM postings').get()!.n, 0);
    assert.throws(() => reader!.exec("INSERT INTO sources(kind, ident, label) VALUES ('greenhouse', 'test', 'Test')"), /locked/);
    writer.exec('COMMIT');
    reader.exec("INSERT INTO sources(kind, ident, label) VALUES ('greenhouse', 'test', 'Test')");
  } finally {
    reader?.close(); writer.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('markDelivered is atomic: a lock collision leaves the whole batch pending, never half', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-contention-'));
  const path = join(dir, 'test.db');
  const writer = openDb(path);
  let reader: ReturnType<typeof openDb> | undefined;
  try {
    const sourceId = Number(
      writer.prepare("INSERT INTO sources(kind, ident, label) VALUES ('greenhouse', 't', 'T')").run().lastInsertRowid,
    );
    const insertEvent = writer.prepare(
      "INSERT INTO events (source_id, posting_id, type, payload_json) VALUES (?, 1, 'posting_opened', '{}')",
    );
    const ids = [1, 2, 3].map(() => Number(insertEvent.run(sourceId).lastInsertRowid));

    writer.exec('BEGIN IMMEDIATE');
    reader = openDb(path, 100);
    assert.throws(() => markDelivered(reader!, ids), /locked/);
    writer.exec('COMMIT');

    assert.equal(
      reader.prepare('SELECT COUNT(*) AS n FROM events WHERE delivered_at IS NOT NULL').get()!.n,
      0,
      'a failed mark must not leave a partially delivered batch that re-sends the rest',
    );
    markDelivered(reader, ids);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events WHERE delivered_at IS NOT NULL').get()!.n, 3);
  } finally {
    reader?.close(); writer.close(); rmSync(dir, { recursive: true, force: true });
  }
});
