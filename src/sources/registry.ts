import type { Adapter, ParsedRef } from "./index.ts";
import type { SourceKind } from "../types.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import { ashby } from "./ashby.ts";
import { personio } from "./personio.ts";
import { smartrecruiters } from "./smartrecruiters.ts";
import { arbeitsagentur } from "./arbeitsagentur.ts";
import { browser } from "./browser.ts";

/**
 * Order matters only for `parseRef`: the first adapter that recognises an input
 * wins. The ATS adapters match narrow, specific hostnames, so `browser` -- which
 * accepts the broadest range of inputs -- must come last or it would swallow
 * references a cheap JSON adapter could have served.
 */
export const ADAPTERS: Adapter[] = [
  greenhouse,
  lever,
  ashby,
  personio,
  smartrecruiters,
  arbeitsagentur,
  browser,
];

export function adapterFor(kind: SourceKind): Adapter {
  const a = ADAPTERS.find((x) => x.kind === kind);
  if (!a) throw new Error(`no adapter for source kind ${kind}`);
  return a;
}

/** Try every adapter in turn. Returns null when none recognises the input. */
export function parseRef(input: string): ParsedRef | null {
  const trimmed = input.trim();
  for (const a of ADAPTERS) {
    const parsed = a.parse(trimmed);
    if (parsed) return parsed;
  }
  return null;
}
