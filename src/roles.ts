/** Deterministic targeting; no network or model calls. Increment when rules change. */
export const ROLE_FILTER_VERSION = 2;
export type RoleFamily = 'ai_llm_application' | 'backend_platform' | 'developer_tools' | 'industrial_ai' | 'ml_systems';
export interface RoleClassification {
  roleFamily: RoleFamily;
  rolePriority: number;
  matchedSignals: string[];
  secondaryRoleFamilies: RoleFamily[];
}
export const roleLabels: Record<RoleFamily, string> = {
  ai_llm_application: 'AI / LLM', backend_platform: 'Backend / Platform',
  developer_tools: 'Dev Tools', industrial_ai: 'Industrial AI', ml_systems: 'ML Systems',
};
function normalize(value: string): string {
  return ' ' + value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ').trim() + ' ';
}
function signals(text: string, terms: string[]): string[] {
  return terms.filter(term => text.includes(normalize(term)));
}
const ai = ['llm', 'llms', 'rag', 'generative ai', 'genai', 'agentic', 'agentic systems', 'agents', 'tool calling', 'mcp', 'model orchestration', 'prompt pipelines', 'guardrails', 'vector databases', 'embeddings', 'llm apis', 'openai', 'anthropic', 'gemini', 'langchain', 'langgraph', 'llamaindex', 'ai workflows'];
const dev = ['developer tools', 'developer tooling', 'developer experience', 'devex', 'developer productivity', 'engineering productivity', 'ai tooling', 'tooling engineer', 'internal tools', 'developer platform', 'developer infrastructure', 'coding agents', 'ide integrations', 'build tools', 'developer workflows', 'ci cd tooling', 'automation tooling', 'observability for developers', 'code generation', 'ai assisted development', 'developer apis'];
const industrial = ['industrial ai', 'digital production', 'digital manufacturing', 'smart factory', 'industry 4.0', 'industrie 4.0', 'digital twin', 'digital twins', 'production data', 'production analytics', 'manufacturing analytics', 'manufacturing ai', 'factory digitalization', 'production digitalization', 'produktionsdigitalisierung', 'digitalisierung produktion', 'industrial data', 'industrial iot', 'iiot', 'manufacturing data engineer', 'production data engineer', 'ai in production', 'opc ua', 'mes', 'scada', 'predictive maintenance', 'machine monitoring', 'factory automation'];
const systems = ['ml systems', 'machine learning systems', 'ml inference', 'inference engineer', 'ai systems', 'model serving', 'inference optimization', 'performance engineer ml', 'c++ ml', 'rust ml', 'ml compilers'];
const backend = ['backend', 'back end', 'fastapi', 'django', 'rest apis', 'microservices', 'event driven', 'backend automation', 'api development'];
const tech = ['python', 'typescript', 'node.js', 'postgresql', 'sqlite', 'redis', 'queues', 'workers', 'docker', 'linux', 'systemd'];

export function classifyRole(title: string, description: string | null): RoleClassification | null {
  const t = normalize(title), d = normalize(description ?? ''), all = t + d;
  if (!passesRoleRules(title, description)) return null;
  const a = signals(all, ai), b = signals(all, backend), dt = signals(all, dev), ind = signals(all, industrial), sy = signals(all, systems), technologies = signals(all, tech);
  const aiTitle = /\b(?:ai|artificial intelligence|llm|genai|generative ai|applied ai|agent|agentic ai|conversational ai|rag)\s+(?:application |software |automation |platform |solutions |systems )?(?:engineer|developer)\b/.test(t)
    || /\b(?:generative ai|genai|llm|ki basierte\w* anwendungen|kunstliche intelligenz)\b/.test(t);
  const candidates: { family: RoleFamily; priority: number; signals: string[] }[] = [];
  const add = (family: RoleFamily, priority: number, matched: string[]) => candidates.push({ family, priority, signals: matched });
  // An unrelated occupational title must not qualify from a boilerplate technology list.
  const noise = /\b(?:sales|vertrieb|helpdesk|it support|network administrator|sap consultant|sap consulting|project manager|product manager|business analyst|data entry|manual test|recruiter)\b/.test(t);
  if (noise) return null;
  if (/\b(frontend|front end|mobile|android|ios|manual qa|embedded hardware|cybersecurity)\b/.test(t) && !aiTitle && !signals(t, dev).length && !/backend|full stack/.test(t)) return null;
  if (aiTitle || a.length >= 3 || (a.length >= 2 && /build|develop|implement|entwick|integrat/.test(d))) add('ai_llm_application', 1, [...a, ...(aiTitle ? [t.trim()] : [])]);
  if (dt.some(s => signals(t, [s]).length) || dt.length >= 2 || (dt.length >= 1 && /build|develop|maintain|entwick/.test(d) && /\b(cli|sdk|tooling|platform)\b/.test(d))) add('developer_tools', 2, dt);
  if (ind.some(s => signals(t, [s]).length) || ind.length >= 2 || (ind.length && /werkstudent|praktik|thesis|masterarbeit|intern|student/.test(t))) add('industrial_ai', 2, ind);
  const backendTitle = /\b(?:backend|back end|python|platform|api|cloud backend|infrastructure software)\s+(?:software )?(?:engineer|engineering|developer)\b|\b(?:working student|werkstudent\w*|intern) (?:backend|platform)\b|\bsoftware engineer backend\b/.test(t);
  const automation = /\bautomation engineer\b/.test(t) && technologies.length >= 1;
  if (backendTitle || automation || (b.length >= 2 && technologies.length >= 1 && /build|develop|implement|maintain|entwick/.test(d))) add('backend_platform', 2, [...b, ...technologies, ...(backendTitle ? [t.trim()] : [])]);
  const inference = signals(all, ['inference', 'quantization', 'cuda', 'onnx', 'tensorrt', 'gpu optimization', 'runtime development']);
  if (sy.length || (inference.length >= 2 && /\b(model|ml|machine learning|neural)\b/.test(all))) add('ml_systems', 3, [...sy, ...inference]);
  // Explicit inference/system titles remain the specialist wildcard category.
  if (signals(t, systems).length && !signals(t, ['generative ai', 'llm application']).length) {
    const index = candidates.findIndex(c => c.family === 'ai_llm_application');
    if (index >= 0) candidates.splice(index, 1);
  }
  candidates.sort((x, y) => x.priority - y.priority);
  const primary = candidates[0];
  if (!primary) return null;
  return { roleFamily: primary.family, rolePriority: primary.priority,
    matchedSignals: [...new Set([...primary.signals, ...technologies])],
    secondaryRoleFamilies: candidates.slice(1).map(c => c.family) };
}

/** Existing seniority, experience and language exclusions, independent of title families. */
export function passesRoleRules(title: string, description: string | null): boolean {
  const t = normalize(title), d = normalize(description ?? "");
  // `head of` with decoration between the words ("Head (m/f/x) of Engineering",
  // "Head (m/w/d) of Data") is the same leadership role; `normalize` turns the
  // decoration into plain tokens, so the pattern allows a few of them.
  if (/\b(senior|sr|staff|principal|lead|manager|director|architect|chief|vp)\b|\bhead\b(?:\s+[a-z0-9]+){0,4}\s+of\b/.test(t)) return false;
  // Experience must describe the candidate, not the company's age or a benefit.
  const raw = (description ?? '').replace(/<[^>]*>/g, ' ').toLowerCase();
  const experience = /(?:\b(?:[5-9]|[1-9]\d)\s*(?:\+|[-–]\s*\d+)?\s*(?:years?|jahre[n]?)\s+(?:(?:of|professional|relevant|commercial|hands.on|industry)\s+){0,3}(?:experience|berufserfahrung|erfahrung)|mindestens\s+(?:[5-9]|[1-9]\d)\s+jahre)/g;
  for (const match of raw.matchAll(experience)) {
    const context = raw.slice(Math.max(0, match.index! - 35), match.index! + match[0].length + 40);
    if (!/preferred|nice.to.have|optional|wunschenswert|idealerweise|not required/.test(context)) return false;
  }
  if (/mehrjahrige berufserfahrung/.test(d) && /fundierte|zwingend|vorausgesetzt|erforderlich|erfahrene[rn]?/.test(d)) return false;
  for (const sentence of (title + '. ' + (description ?? '')).split(/[.!;\n]/)) {
    const language = normalize(sentence);
    if (/(?:german|deutsch)(?: language)?(?: level|kenntnisse)?\s+(?:c1|c2)|(?:c1|c2)\s+(?:german|deutsch)|verhandlungssicher\w*\s+(?:deutsch|deutschkenntnisse)/.test(language)
      && !/preferred|optional|nice to have|not required|wunschenswert|idealerweise/.test(language)) return false;
  }
  return true;
}
