import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, addSource, upsertPosting, setJevFit, deferFit } from './db.ts';
import { jevStats, renderJevStats } from './stats.ts';

const cfg = { fitThreshold: 75, fitConfidence: 0.8 };
test('stats separate model results, rules, stale versions and deferred work; survive reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-stats-'));
  const path = join(dir, 'stats.db');
  let db = openDb(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = addSource(db, 'greenhouse', 'example', 'Example');
  function posting(name: string) {
    return upsertPosting(db, { source_id: source.id, key: name, external_id: name,
      title: name, company: 'Example', location: 'Worldwide', remote: 1, department: null,
      url: 'https://example.com/' + name, posted_at: new Date().toISOString(), posted_at_exact: 0,
      closes_at: null, description: 'Example description' });
  }
  function result(id: number, score = 80, confidence = 0.9, eligible = true, version = 'current', details = '{"answers":{}}') {
    setJevFit(db, id, { score, confidence, eligible, reason: 'Example', details }, version);
  }
  const matched = posting('match'); result(matched); result(matched); // rescore is not another job
  result(posting('low-score'), 50);
  result(posting('uncertain'), 90, 0.3);
  result(posting('ineligible'), 90, 0.9, false);
  result(posting('rules'), 0, 1, false, 'current', '{}');
  result(posting('outdated'), 90, 0.9, true, 'old');
  const retry = posting('retry'); deferFit(db, retry);
  posting('new');
  const closed = posting('closed'); result(closed);
  db.prepare("UPDATE postings SET state='closed' WHERE id=?").run(closed);
  const expected = { stored: 9, evaluated: 6, open: 8, current_evaluated: 4,
    matched: 1, rule_excluded: 1, pending: 3, deferred: 1 };
  assert.deepEqual({ ...jevStats(db, cfg, 'current') }, expected);
  assert.equal(jevStats(db, { ...cfg, fitThreshold: 95 }, 'current').matched, 0);
  assert.equal(jevStats(db, cfg, 'changed-profile').pending, 8);
  db.close(); db = openDb(path);
  assert.deepEqual({ ...jevStats(db, cfg, 'current') }, expected);
  const text = renderJevStats(expected, cfg);
  assert.match(text, /Filtered out by Jev: \*\*3\*\*/);
  assert.match(text, /Waiting for evaluation: \*\*3\*\* \(1 waiting for retry\)/);
  assert.ok(text.length < 2000);
});

test('empty database returns zeros without NaN', () => {
  const db = openDb(':memory:');
  try {
    const stats = jevStats(db, cfg, 'current');
    assert.ok(Object.values(stats).every(value => value === 0));
    assert.ok(!renderJevStats(stats, cfg).includes('NaN'));
  } finally { db.close(); }
});
