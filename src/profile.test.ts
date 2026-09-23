import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, addSource, upsertPosting, getPosting, listUnscoredPostings, setJevFit, queueEvent, pendingEvents } from "./db.ts";
import { applyFilter, filterHash } from "./filter.ts";
import { jevContext, parseJev, scoreJev, isMatch } from "./jev.ts";
import { jobDescription, enrichDescription } from "./enrich.ts";
import { parseRemotive } from "./sources/remotive.ts";
import { drain } from "./delivery.ts";
import { scoreCycle, pollSource } from "./poller.ts";
import { loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { FetchedPosting, PostingRow } from "./types.ts";
import type { TextChannel } from "discord.js";

const evidence = { resume: {skills: ['Python', 'TypeScript']}, work_eligibility: {Germany: true}, identity: {email: 'private@example.test'} };
function response(choice = 'satisfied', confidence = 0.95, score = 3.5) {
  return {model: 'jev-1.13.0', answers: {
    ...Object.fromEntries(['experience','education','language','eligibility','technology'].map(id => [id, {type:'choice', choice, confidence}])),
    relevance: {type:'score', score, confidence},
  }};
}
const fetched: FetchedPosting = {externalId:'123', title:'Research Software Associate',company:'Example',location:'Worldwide',remote:true,department:null,url:'https://www.linkedin.com/jobs/view/123',postedAt:null,closesAt:null,description:'Build Python and TypeScript tools. No required degree; English. Worldwide hiring.'};
function setup(t: {after(fn: () => void): void}) {
  const dir = mkdtempSync(join(tmpdir(), 'eve-profile-'));
  const profilePath = join(dir,'profile.json'); writeFileSync(profilePath, JSON.stringify(evidence));
  const db = openDb(':memory:');
  const source = addSource(db,'linkedin','software@Worldwide','Global');
  const id = upsertPosting(db,{source_id:source.id,key:'same-job',external_id:'123',title:fetched.title,company:fetched.company,location:fetched.location,remote:1,department:null,url:fetched.url,posted_at:new Date().toISOString(),posted_at_exact:0,closes_at:null,description:fetched.description});
  const cfg: Config = {dbPath:':memory:',discordToken:'test',discordChannelId:'test',digestThreshold:5,pingTarget:'',profilePath,fitModel:'jev-1.13.0',fitThreshold:75,fitConfidence:0.8,fitProvider:'typesafe',matchesOnly:true,fitConcurrency:2,fitBudget:10,freshHours:48,freshPingHours:3,alertMaxAgeHours:24,staleDays:7,deadlineDays:3,maxFailures:5,massDelistRatio:0.5,filtersPath:null,browserUseDir:null,browserUsePython:'python3',browserTimeoutMin:10,dashboardPort:8787,dashboardBind:'127.0.0.1',statsTimezone:'Europe/Berlin'};
  t.after(() => {db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,id,cfg,profilePath,source};
}

test('profile discovery admits unfamiliar titles while preserving geography and hard exclusions', () => {
  assert.equal(applyFilter([fetched], {}).length, 0);
  const spec = {targeting:'profile' as const, remote:'include' as const, locationAny:['Germany'],locationNone:['|us|']};
  assert.equal(applyFilter([fetched],spec).length,1);
  assert.equal(applyFilter([{...fetched,location:'US only'}],spec).length,0);
  assert.equal(applyFilter([{...fetched,title:'Senior Research Engineer'}],spec).length,0);
  assert.equal(applyFilter([{...fetched,description:'Required German C1.'}],spec).length,0);
  assert.notEqual(filterHash({}), filterHash({targeting:'profile'}));
});
test('high confidence rejection and unknown eligibility never qualify; low confidence waits', () => {
  for (const choice of ['contradicted','unknown']) assert.equal(parseJev(response(choice))!.eligible,false);
  const fit = parseJev(response())!;
  assert.equal(fit.score,88); assert.equal(fit.eligible,true);
  const p = {state:'open',fit_eligible:1,fit_score:88,fit_confidence:0.4} as PostingRow;
  assert.equal(isMatch(p,{fitThreshold:75,fitConfidence:0.8} as Config),false);
  assert.equal(parseJev(response('satisfied',NaN)),null);
  assert.equal(parseJev(response('satisfied',0.95,5)),null);
  assert.equal(parseJev({answers:{}}),null);
});
test('profile fingerprint excludes contact data and changes with capabilities', async t => {
  const {cfg,profilePath} = setup(t);
  const first = (await jevContext(cfg))!;
  assert.ok(!first.profile.includes('private@example.test'));
  writeFileSync(profilePath,JSON.stringify({...evidence,identity:{email:'other@example.test'}}));
  assert.equal((await jevContext(cfg))!.version,first.version);
  writeFileSync(profilePath,JSON.stringify({...evidence,resume:{skills:['Rust']}}));
  assert.notEqual((await jevContext(cfg))!.version,first.version);
});
test('Jev sends evidence and typed questions; API failures do not become rejection scores', async t => {
  const {db,id,cfg} = setup(t); const context = (await jevContext(cfg))!;
  const request = (async (url, init) => {
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(init!.body));
    assert.equal(body.model,cfg.fitModel);assert.equal(body.questions.eligibility.type,'choice');
    assert.ok(!JSON.stringify(body).includes('private@example.test'));
    return Response.json(response());
  }) as typeof fetch;
  assert.equal((await scoreJev(getPosting(db,id)!,context,'test-key',request))!.eligible,true);
  const failed = (async () => new Response('',{status:401})) as typeof fetch;
  assert.equal(await scoreJev(getPosting(db,id)!,context,'test-key',failed),null);
});
test('description extraction accepts JobPosting evidence, not generic page text, and blocks foreign redirects', async () => {
  assert.equal(jobDescription('<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","description":"<p>Python work</p>"}]}</script>'),'Python work');
  assert.equal(jobDescription('<p>Sign in to read this job</p>'),null);
  let calls=0;
  const request = (async () => {calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}) as typeof fetch;
  assert.equal(await enrichDescription({...fetched,external_id:'123'} as unknown as PostingRow,request),null);
  assert.equal(calls,1);
});
test('scoring queue includes unclassified jobs, caches results and invalidates changed content', async t => {
  const {db,id,cfg} = setup(t);const {version}=(await jevContext(cfg))!;
  assert.equal(listUnscoredPostings(db,25,version).length,1);
  setJevFit(db,id,parseJev(response())!,version);
  assert.equal(listUnscoredPostings(db,25,version).length,0);
  const row=getPosting(db,id)!;
  upsertPosting(db,{...row,description:'Changed requirements'});
  assert.equal(listUnscoredPostings(db,25,version).length,1);
});
test('Discord sends one passing match, suppresses raw openings, and retries failed delivery', async t => {
  const {db,id,cfg,source}=setup(t);const {version}=(await jevContext(cfg))!;
  setJevFit(db,id,parseJev(response())!,version);
  queueEvent(db,source.id,id,'fresh_opening');queueEvent(db,source.id,id,'posting_opened');
  queueEvent(db,source.id,id,'high_fit',{profileMatch:true,confidence:0.95});
  let attempts=0;
  const channel={send:async () => {attempts++;if(attempts===1) throw new Error('offline');return {id:'message'};}} as unknown as TextChannel;
  await drain(db,channel,cfg);
  assert.equal(pendingEvents(db,100,true).length,1);
  assert.equal(getPosting(db,id)!.fit_notified_at,null);
  await drain(db,channel,cfg);
  assert.equal(attempts,2);assert.equal(pendingEvents(db,100,true).length,0);
  assert.ok(getPosting(db,id)!.fit_notified_at);
});
test('closed jobs, stale profile scores and confident rejections cannot reach Discord', async t => {
  const {db,id,cfg,source}=setup(t);const {version}=(await jevContext(cfg))!;
  let sends=0;const channel={send:async () => {sends++;}} as unknown as TextChannel;
  for (const v of ['old-version',version]) {
    setJevFit(db,id,parseJev(response(v==='old-version'?'satisfied':'contradicted'))!,v);
    queueEvent(db,source.id,id,'high_fit');await drain(db,channel,cfg);
  }
  setJevFit(db,id,parseJev(response())!,version);db.prepare("UPDATE postings SET state='closed' WHERE id=?").run(id);
  queueEvent(db,source.id,id,'high_fit');await drain(db,channel,cfg);
  assert.equal(sends,0);
});
test('profile scoring queues undated matches and does not repeat a queued notification', async t => {
  const {db,id,cfg}=setup(t);
  t.mock.method(globalThis,'fetch',async () => Response.json(response()));
  const old=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='test';
  t.after(()=>{if(old===undefined) delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
  assert.equal(await scoreCycle(db,cfg),1);
  assert.equal(await scoreCycle(db,cfg),0);
  const events=pendingEvents(db,100,true);assert.equal(events.length,1);assert.equal(events[0]!.type,'high_fit');
  assert.equal(getPosting(db,id)!.posted_at_exact,0);
});
test('Remotive validates full feed and preserves country restrictions and original URLs', () => {
  const jobs=[{id:1,title:'Engineer',company_name:'Example',url:'https://remotive.com/remote-jobs/1',candidate_required_location:'US only',description:'<p>Work</p>'}];
  assert.throws(()=>parseRemotive({'job-count':2,jobs}));
  const p=parseRemotive({'job-count':1,jobs})[0]!;
  assert.equal(p.location,'US only');assert.equal(p.description,'Work');assert.equal(p.remote,true);
});
test('source-specific cadence skips frequent feed requests even after a filter change', async t => {
  const {db,cfg,source}=setup(t);let calls=0;
  const report=await pollSource(db,cfg,{...source,last_poll:new Date().toISOString()},{kind:'remotive',minPollIntervalMs:21600000,parse:()=>null,fetch:async()=>{calls++;return {postings:[],etag:null};}},{default:{targeting:'profile'}});
  assert.equal(calls,0);assert.equal(report.skipped,true);
});
test('configuration rejects invalid confidence and missing Jev credentials', t => {
  const names=['DISCORD_TOKEN','DISCORD_CHANNEL_ID','RADAR_FIT_PROVIDER','RADAR_FIT_CONFIDENCE','TYPESAFE_API_KEY'];
  const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
  process.env.DISCORD_TOKEN='test';process.env.DISCORD_CHANNEL_ID='test';process.env.RADAR_FIT_PROVIDER='typesafe';
  process.env.RADAR_FIT_CONFIDENCE='80';assert.throws(loadConfig,/between 0 and 1/);
  process.env.RADAR_FIT_CONFIDENCE='0.8';delete process.env.TYPESAFE_API_KEY;assert.throws(loadConfig,/requires TYPESAFE/);
});
test('an explicit RADAR_MATCHES_ONLY=false is honoured with TypeSafe scoring', t => {
  const names=['DISCORD_TOKEN','DISCORD_CHANNEL_ID','RADAR_FIT_PROVIDER','RADAR_MATCHES_ONLY','TYPESAFE_API_KEY','RADAR_PROFILE'];
  const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
  process.env.DISCORD_TOKEN='test';process.env.DISCORD_CHANNEL_ID='test';
  process.env.RADAR_FIT_PROVIDER='typesafe';process.env.TYPESAFE_API_KEY='test';process.env.RADAR_PROFILE='profile.json';
  delete process.env.RADAR_MATCHES_ONLY;
  assert.equal(loadConfig().matchesOnly,true,'unset defaults to matches-only for TypeSafe');
  process.env.RADAR_MATCHES_ONLY='false';
  assert.equal(loadConfig().matchesOnly,false,'an explicit false must re-enable raw alerts');
  process.env.RADAR_MATCHES_ONLY='true';
  assert.equal(loadConfig().matchesOnly,true);
});

test('retained jobs outside the current geography never reach the API or Discord', async t => {
  const {db,id,cfg,source,profilePath}=setup(t);
  const filtersPath=join(profilePath,'..','filters.json');
  writeFileSync(filtersPath,JSON.stringify({default:{targeting:'profile',remote:'include',locationNone:['|us|']}}));
  cfg.filtersPath=filtersPath;
  db.prepare("UPDATE postings SET location='US only' WHERE id=?").run(id);
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(response());});
  const old=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='test';
  t.after(()=>{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
  await scoreCycle(db,cfg);assert.equal(calls,0);assert.equal(getPosting(db,id)!.fit_eligible,0);
  // Even a manually injected positive result cannot bypass the geographic gate.
  setJevFit(db,id,parseJev(response())!,(await jevContext(cfg))!.version);
  queueEvent(db,source.id,id,'high_fit');
  await drain(db,{send:async()=>{calls++;}} as unknown as TextChannel,cfg);
  assert.equal(calls,0);
});
