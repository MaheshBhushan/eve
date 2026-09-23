import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';

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
