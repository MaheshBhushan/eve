import type { SourceKind } from "./types.ts";

/**
 * Provider payload contracts.
 *
 * Each contract versions the job shape we expect from one provider and states
 * explicitly which raw attribute feeds which `FetchedPosting` field. Adapters
 * validate every raw job against it before returning a snapshot: a job missing
 * a required attribute fails the whole fetch, so the poller never commits a
 * snapshot built from a payload it does not understand. Attributes the
 * contract neither maps nor ignores are reported, not silently dropped, so a
 * provider schema change shows up in the logs before it turns into data loss.
 */
export interface FieldMapping {
  /** Raw attribute name on the provider's job object. */
  source: string;
  /** `FetchedPosting` field it feeds, or a note on how it is used. */
  target: string;
  required?: boolean;
  type: "string" | "number" | "boolean" | "object" | "array";
}

export interface ProviderContract {
  kind: SourceKind;
  version: number;
  fields: FieldMapping[];
  /** Attributes known to exist and deliberately unused. */
  ignored: string[];
}

export interface MappingReport {
  kind: SourceKind;
  version: number;
  jobs: number;
  /** One entry per job that broke a required-field or type rule. */
  violations: Array<{ index: number; id: string | null; problems: string[] }>;
  /** Unmapped attribute name -> number of jobs carrying it. */
  unmapped: Record<string, number>;
}

export const CONTRACTS: Partial<Record<SourceKind, ProviderContract>> = {
  greenhouse: {
    kind: "greenhouse",
    version: 1,
    fields: [
      { source: "id", target: "externalId", required: true, type: "number" },
      { source: "title", target: "title", required: true, type: "string" },
      { source: "absolute_url", target: "url", required: true, type: "string" },
      { source: "company_name", target: "company", type: "string" },
      { source: "location", target: "location (.name)", type: "object" },
      { source: "departments", target: "department ([0].name)", type: "array" },
      { source: "first_published", target: "postedAt", type: "string" },
      { source: "updated_at", target: "postedAt (fallback)", type: "string" },
      { source: "application_deadline", target: "closesAt", type: "string" },
      { source: "content", target: "description", type: "string" },
    ],
    ignored: ["internal_job_id", "metadata", "requisition_id", "data_compliance", "offices", "language"],
  },
  lever: {
    kind: "lever",
    version: 1,
    fields: [
      { source: "id", target: "externalId", required: true, type: "string" },
      { source: "text", target: "title", required: true, type: "string" },
      { source: "hostedUrl", target: "url", required: true, type: "string" },
      { source: "applyUrl", target: "url (unused fallback)", type: "string" },
      { source: "createdAt", target: "postedAt", type: "number" },
      { source: "workplaceType", target: "remote", type: "string" },
      { source: "country", target: "location (fallback)", type: "string" },
      { source: "categories", target: "location, department", type: "object" },
      { source: "descriptionPlain", target: "description", type: "string" },
      { source: "additionalPlain", target: "description", type: "string" },
      { source: "openingPlain", target: "description", type: "string" },
      { source: "lists", target: "description", type: "array" },
    ],
    ignored: ["description", "additional", "opening", "descriptionBody", "descriptionBodyPlain", "salaryRange", "salaryDescription", "salaryDescriptionPlain"],
  },
  ashby: {
    kind: "ashby",
    version: 1,
    fields: [
      { source: "id", target: "externalId", required: true, type: "string" },
      { source: "title", target: "title", required: true, type: "string" },
      { source: "jobUrl", target: "url", type: "string" },
      { source: "applyUrl", target: "url (fallback)", type: "string" },
      { source: "department", target: "department", type: "string" },
      { source: "team", target: "department (fallback)", type: "string" },
      { source: "location", target: "location", type: "string" },
      { source: "secondaryLocations", target: "location", type: "array" },
      { source: "publishedAt", target: "postedAt", type: "string" },
      { source: "isListed", target: "listing filter", type: "boolean" },
      { source: "isRemote", target: "remote", type: "boolean" },
      { source: "workplaceType", target: "remote (fallback)", type: "string" },
      { source: "descriptionHtml", target: "description (fallback)", type: "string" },
      { source: "descriptionPlain", target: "description", type: "string" },
    ],
    ignored: ["employmentType", "address", "compensation", "shouldDisplayCompensationOnJobPostings"],
  },
};

function typeOf(v: unknown): FieldMapping["type"] | "null" | "other" {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "object" ? t : "other";
}

/** Check raw provider jobs against a contract. Pure; never throws. */
export function checkPayload(contract: ProviderContract, jobs: unknown[]): MappingReport {
  const known = new Set([...contract.fields.map((f) => f.source), ...contract.ignored]);
  const report: MappingReport = {
    kind: contract.kind,
    version: contract.version,
    jobs: jobs.length,
    violations: [],
    unmapped: {},
  };
  jobs.forEach((job, index) => {
    if (typeOf(job) !== "object") {
      report.violations.push({ index, id: null, problems: ["job is not an object"] });
      return;
    }
    const rec = job as Record<string, unknown>;
    const problems: string[] = [];
    for (const f of contract.fields) {
      const actual = typeOf(rec[f.source]);
      if (actual === "null") {
        if (f.required) problems.push(`missing required ${f.source}`);
      } else if (actual !== f.type) {
        problems.push(`${f.source} expected ${f.type}, got ${actual}`);
      } else if (f.required && f.type === "string" && (rec[f.source] as string).trim() === "") {
        problems.push(`empty required ${f.source}`);
      }
    }
    if (problems.length) {
      const id = rec["id"];
      report.violations.push({ index, id: id == null ? null : String(id), problems });
    }
    for (const key of Object.keys(rec)) {
      if (!known.has(key)) report.unmapped[key] = (report.unmapped[key] ?? 0) + 1;
    }
  });
  return report;
}

export function formatReport(r: MappingReport, ident: string): string {
  const lines = [`${r.kind}@v${r.version} ${ident}: ${r.jobs} jobs, ${r.violations.length} incompatible`];
  for (const v of r.violations.slice(0, 5)) {
    lines.push(`  job #${v.index} (${v.id ?? "no id"}): ${v.problems.join("; ")}`);
  }
  const unmapped = Object.entries(r.unmapped);
  if (unmapped.length) {
    lines.push(`  unmapped attributes: ${unmapped.map(([k, n]) => `${k} (${n})`).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Validate a raw provider payload before an adapter maps it. Throws on any
 * required-field or type violation so the poll fails instead of committing a
 * partial snapshot; logs unmapped attributes as a warning.
 */
export function enforceContract(
  kind: SourceKind,
  ident: string,
  jobs: unknown[],
  warn: (msg: string) => void = console.warn,
): MappingReport | null {
  const contract = CONTRACTS[kind];
  if (!contract) return null;
  const report = checkPayload(contract, jobs);
  if (report.violations.length) {
    throw new Error(`provider contract violated: ${formatReport(report, ident)}`);
  }
  if (Object.keys(report.unmapped).length) warn(`[contract] ${formatReport(report, ident)}`);
  return report;
}
