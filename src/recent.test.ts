import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recentPostingSql } from "./recent.ts";

test("recent window uses publication age and discovery only for undated jobs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE postings (id INTEGER, posted_at TEXT, posted_at_exact INTEGER, first_seen TEXT);
      INSERT INTO postings VALUES
        (1, datetime('now', '-2 hours'), 1, datetime('now')),
        (2, datetime('now', '-7 days'), 1, datetime('now')),
        (3, datetime('now'), 0, datetime('now', '-2 hours')),
        (4, datetime('now'), 0, datetime('now', '-7 days')),
        (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours'), 1, datetime('now'));`);
    const rows = db.prepare(`SELECT id FROM postings p WHERE ${recentPostingSql('p', '24')} ORDER BY id`).all();
    assert.deepEqual(rows.map(row => row.id), [1, 3, 5]);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM postings WHERE ${recentPostingSql('', undefined)}`).get()?.n, 5);
  } finally {
    db.close();
  }
});

test("recent window rejects invalid configuration", () => {
  for (const value of ["", "0", "-1", "NaN", "Infinity", "24; DROP TABLE postings"])
    assert.throws(() => recentPostingSql('', value), /positive number/);
});
