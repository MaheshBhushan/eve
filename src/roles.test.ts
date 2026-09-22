import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRole } from './roles.ts';
import { applyFilter } from './filter.ts';
import { openDb, addSource, upsertPosting, listUnscoredPostings } from './db.ts';
import type { FetchedPosting } from './types.ts';

const examples = [
  ['Working Student Software Engineering, Generative AI', null, 'ai_llm_application'],
  ['Werkstudent Softwareentwicklung für KI-basierte Anwendungen', null, 'ai_llm_application'],
  ['Innovation Intern', 'Develop agents using RAG, tool calling and LangGraph.', 'ai_llm_application'],
  ['Junior Backend Engineer', '3 years experience with Python and FastAPI.', 'backend_platform'],
  ['Software Engineer', 'Develop backend microservices using Python and Redis.', 'backend_platform'],
  ['Software Engineer, Engineering Productivity', null, 'developer_tools'],
  ['Tooling Engineer', 'Build CLI tools and SDKs.', 'developer_tools'],
  ['Software Engineer', 'Build CLI and SDK developer tooling for engineering teams.', 'developer_tools'],
  ['Werkstudent Digitalisierung Produktion', null, 'industrial_ai'],
  ['Master Thesis', 'Apply OPC UA to production optimization.', 'industrial_ai'],
  ['ML Systems Engineer', 'CUDA inference quantization', 'ml_systems'],
  ['AI Systems Engineer', 'Model serving with TensorRT.', 'ml_systems'],
  ['AI Engineer', 'You will lead experiments. First experience preferred. German B2.', 'ai_llm_application'],
  ['AI Engineer', 'German C1 preferred. Python required.', 'ai_llm_application'],
  ['AI Engineer', '5 years experience preferred; internships welcome.', 'ai_llm_application'],
] as const;
for (const [title, description, family] of examples) test(`classifies ${title}: ${description}`, () => {
  const result = classifyRole(title, description);
  assert.equal(result?.roleFamily, family);
  assert.ok(result!.matchedSignals.length > 0);
});
for (const title of ['Senior AI Engineer', 'Sr. Backend Engineer', 'Staff LLM Engineer', 'Principal AI Engineer', 'Lead Backend Engineer', 'AI Architect', 'Engineering Manager', 'Director AI', 'Head of AI', 'Head (m/f/x) of Engineering', 'Head (m/w/d) of Data', 'Frontend Developer', 'Mobile Developer', 'SAP Consultant', 'IT Support', 'Network Administrator', 'Manual QA Tester', 'Business Analyst', 'Data Analyst', 'Werkstudent Marketing']) {
  test(`rejects ${title}`, () => assert.equal(classifyRole(title, 'Python experience preferred'), null));
}
for (const description of ['Requires 5+ years of experience.', 'Minimum 6 years professional experience.', '10+ years of relevant experience required.', 'Mindestens 5 Jahre Berufserfahrung.', 'Fundierte mehrjährige Berufserfahrung erforderlich.', 'German C1 required.', 'Deutsch C2 erforderlich.', 'Verhandlungssicheres Deutsch.']) {
  test(`excludes requirement: ${description}`, () => assert.equal(classifyRole('AI Engineer', description), null));
}
test('generic Python mention does not qualify', () => assert.equal(classifyRole('Software Engineer', 'Python is one of our many technologies.'), null));
test('AI wins over meaningful backend work', () => {
  const r = classifyRole('AI Engineer', 'Develop backend microservices with Python, RAG and LangChain.');
  assert.equal(r?.rolePriority, 1);
  assert.ok(r?.secondaryRoleFamilies.includes('backend_platform'));
});
test('worldwide roles pass the same mandatory filter without config', () => {
  for (const location of ['India', 'United States', 'United Kingdom', 'Germany', 'Japan', 'Remote']) {
    const p: FetchedPosting = {externalId:'1', title:'Junior AI Engineer', company:'Acme', location, remote:false, department:null, url:'https://example.com', postedAt:null, closesAt:null, description:null};
    assert.equal(applyFilter([p], {}).length, 1);
    assert.equal(applyFilter([{...p, title:'Student Sales Assistant'}], {}).length, 0);
  }
});
test('stored classification excludes old noise from the scoring backlog', () => {
  const db = openDb(':memory:');
  try {
    const source = addSource(db, 'lever', 'test', 'Test');
    const base = {source_id:source.id, external_id:'1', company:'Acme', location:'India', remote:0, department:null, url:'https://example.com', posted_at:new Date().toISOString(), posted_at_exact:1, closes_at:null};
    upsertPosting(db, {...base, key:'bad', title:'Marketing Intern', description:'Python'});
    const id = upsertPosting(db, {...base, key:'good', title:'AI Engineer', description:'Build RAG applications.'});
    assert.deepEqual(listUnscoredPostings(db).map(p => p.id), [id]);
    const row = db.prepare('SELECT roleFamily, rolePriority, matchedSignals FROM postings WHERE id = ?').get(id)!;
    assert.equal(row.roleFamily, 'ai_llm_application');
    assert.equal(row.rolePriority, 1);
    assert.ok(JSON.parse(row.matchedSignals as string).includes('rag'));
  } finally { db.close(); }
});
