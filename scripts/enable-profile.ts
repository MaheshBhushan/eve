/** Enable profile discovery only after credentials and profile have been validated. */
import { copyFileSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { addSource, openDb } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { loadProfile } from "../src/fit.ts";
import { loadFilters } from "../src/filter.ts";
import { parseRef } from "../src/sources/registry.ts";

async function main(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY;
  const profile = process.env.RADAR_PROFILE;
  if (!key || !profile) throw new Error("Set TYPESAFE_API_KEY and RADAR_PROFILE in .env first. No changes made.");
  if (!await loadProfile(profile, 48_000)) throw new Error("Profile is unreadable, too large, or has no supported capability sections. No changes made.");
  const response = await fetch("https://api.typesafe.ai/v1/models", {headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error(`TypeSafe credential check returned HTTP ${response.status}. No changes made.`);
  await response.body?.cancel();
  const filterPath = resolve('config/filters.profile.json');
  loadFilters(filterPath);
  const entries = JSON.parse(readFileSync('config/discovery.profile.json','utf8')).boards as {ref:string}[];
  const refs = entries.map(e => {const ref=parseRef(e.ref);if(!ref) throw new Error(`Invalid discovery source ${e.ref}`);return ref;});
  const envPath=resolve('.env');
  let env=readFileSync(envPath,'utf8');
  const settings: Record<string,string> = {RADAR_FIT_PROVIDER:'typesafe',RADAR_JEV_MODEL:process.env.RADAR_JEV_MODEL ?? 'jev-1.13.0',RADAR_FIT_CONFIDENCE:process.env.RADAR_FIT_CONFIDENCE ?? '0.8',RADAR_MATCHES_ONLY:'true',RADAR_FILTERS:JSON.stringify(filterPath)};
  for (const [name,value] of Object.entries(settings)) {
    const line=new RegExp(`^${name}=.*$`,'m');
    env=line.test(env)?env.replace(line,()=>`${name}=${value}`):`${env.trimEnd()}\n${name}=${value}\n`;
  }
  // Validate the exact resulting runtime configuration before touching files or DB.
  process.env.RADAR_FIT_PROVIDER='typesafe';
  process.env.RADAR_FILTERS=filterPath;
  process.env.RADAR_MATCHES_ONLY='true';
  loadConfig();
  const stamp=Date.now();
  copyFileSync(envPath,`${envPath}.before-profile-${stamp}`);
  chmodSync(`${envPath}.before-profile-${stamp}`,0o600);
  const dbPath=process.env.RADAR_DB ?? 'eve.db';
  const db=openDb(dbPath);
  try {
    db.prepare('VACUUM INTO ?').run(`${dbPath}.before-profile-${stamp}`);
    db.exec('BEGIN IMMEDIATE');
    try { for(const ref of refs) addSource(db,ref.kind,ref.ident,ref.label); db.exec('COMMIT'); }
    catch(error) {db.exec('ROLLBACK');throw error;}
    writeFileSync(envPath,env,{mode:0o600});
    chmodSync(envPath,0o600);
  } finally {db.close();}
  for(const unit of ['eve-bot.service','eve-dashboard.service']) {
    const status=spawnSync('systemctl',['--user','is-active','--quiet',unit]);
    if(status.status===0) {
      const result=spawnSync('systemctl',['--user','restart',unit],{stdio:'inherit'});
      if(result.status!==0) throw new Error(`Configured successfully, but restart ${unit} manually.`);
    }
  }
  console.log('Profile discovery enabled. Existing sources retained; new sources registered. The next poll will classify jobs and deliver passing matches.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
