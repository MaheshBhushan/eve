/** Replace registered search queries without fetching, deleting history or sending events. */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, addSource, listSources } from '../src/db.ts';
import { parseRef } from '../src/sources/registry.ts';

try { process.loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const searchKinds = new Set(['arbeitsagentur', 'linkedin', 'stepstone', 'indeed', 'xing']);
const refs = ['config/searches.json', 'config/boards.json'].flatMap(path => {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  return config.boards.map((entry: {ref: string}) => parseRef(entry.ref));
}).filter(ref => ref && searchKinds.has(ref.kind));
const desired = new Map(refs.map(ref => [`${ref!.kind}:${ref!.ident}`, ref!]));
const path = process.env.RADAR_DB ?? 'eve.db';
const raw = new DatabaseSync(path);
raw.exec('PRAGMA busy_timeout = 5000');
const backup = `${path}.before-role-targeting-${Date.now()}`;
raw.prepare('VACUUM INTO ?').run(backup);
raw.close();
const db = openDb(path);
const maxFailures = Number(process.env.RADAR_MAX_FAILURES ?? 5);
db.exec('BEGIN IMMEDIATE');
try {
  let muted = 0;
  for (const source of listSources(db)) {
    if (searchKinds.has(source.kind) && !desired.has(`${source.kind}:${source.ident}`)) {
      // A far-future probe time retires the search; the backoff probe would otherwise revive it.
      db.prepare("UPDATE sources SET fail_count = ?, next_attempt_at = '9999-12-31 00:00:00' WHERE id = ?").run(maxFailures, source.id);
      muted++;
    }
  }
  for (const ref of desired.values()) {
    const source = addSource(db, ref.kind, ref.ident, ref.label);
    db.prepare('UPDATE sources SET fail_count = 0, next_attempt_at = NULL, etag = NULL, filter_hash = NULL WHERE id = ?').run(source.id);
  }
  db.exec('COMMIT');
  console.log(JSON.stringify({backup, mutedLegacySearches:muted, focusedSearches:desired.size}));
} catch (error) { db.exec('ROLLBACK'); throw error; }
finally { db.close(); }
