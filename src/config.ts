/** Single-channel deployment: one DISCORD_CHANNEL_ID for every watched source. */
export interface Config {
  dbPath: string;
  discordToken: string;
  discordChannelId: string;
  /** Batch into a single digest embed once a cycle exceeds this many postings. */
  digestThreshold: number;
  /** Prefix on actionable alerts. `<@id>` for a DM-style ping, or `@here`. */
  pingTarget: string;

  /* ------------------------------------------------------------- fit --- */
  /**
   * Path to the profile JSON the fit scorer reads. Deliberately a path and not
   * an import: job-pipeline owns that file, and pointing at it keeps one source
   * of truth without coupling the two codebases. Unset disables scoring, and
   * the high-fit alert with it.
   */
  profilePath: string | null;
  /** Model for the scorer, run through the `claude` CLI headless. */
  fitModel: string;
  /** Score at or above this pings you. Below it, the posting is still tracked. */
  fitThreshold: number;
  /**
   * A posting only counts as "fresh" for this many hours after it was
   * published. Applying early is the biggest controllable factor in getting a
   * reply, which is why freshness gates the alert at all.
   */
  freshHours: number;
  /** Max fit scorings per cycle. Each is an LLM call; this bounds the spend. */
  fitBudget: number;

  /* ---------------------------------------------------------- sweeps --- */
  /** Claimed but not applied for this long -> a nudge. */
  staleDays: number;
  /** Ping this many days before a stated application deadline. */
  deadlineDays: number;
  /**
   * Consecutive poll failures before a source is muted. Companies do delete
   * their boards, and retrying a dead one forever is just log noise.
   */
  maxFailures: number;
  /**
   * Refuse to act on a snapshot that lost more than this fraction of a board's
   * open postings in one cycle. A board erroring out mid-pagination looks
   * exactly like a mass delisting, and mass-closing a company's whole board on
   * a bad fetch is the worst failure this system has -- it would wipe the
   * claims and alerts you actually care about.
   */
  massDelistRatio: number;

  /* --------------------------------------------------------- filter --- */
  /**
   * Path to the JSON filter config. Unset -- or a path that does not exist --
   * means no filtering, so every posting on every watched board is tracked.
   * A file that exists but is malformed is a hard error rather than a silent
   * fallback; see `loadFilters`. `config/filters.example.json` is the template.
   */
  filtersPath: string | null;

  /* --------------------------------------------------------- browser --- */
  /** Path to the browser-use checkout used by the `browser` adapter. */
  browserUseDir: string | null;
  /** Python interpreter for browser-use (its own venv). */
  browserUsePython: string;
  /** Max minutes one browser-driven search may run before being killed. */
  browserTimeoutMin: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    dbPath: process.env.RADAR_DB ?? "jobradar.db",
    discordToken: req("DISCORD_TOKEN"),
    discordChannelId: req("DISCORD_CHANNEL_ID"),
    digestThreshold: Number(process.env.RADAR_DIGEST_THRESHOLD ?? 5),
    pingTarget: process.env.RADAR_PING ? `<@${process.env.RADAR_PING}>` : "@here",

    profilePath: process.env.RADAR_PROFILE ?? null,
    fitModel: process.env.RADAR_FIT_MODEL ?? "sonnet",
    fitThreshold: Number(process.env.RADAR_FIT_THRESHOLD ?? 75),
    freshHours: Number(process.env.RADAR_FRESH_HOURS ?? 48),
    fitBudget: Number(process.env.RADAR_FIT_BUDGET ?? 25),

    staleDays: Number(process.env.RADAR_STALE_DAYS ?? 7),
    deadlineDays: Number(process.env.RADAR_DEADLINE_DAYS ?? 3),
    maxFailures: Number(process.env.RADAR_MAX_FAILURES ?? 5),
    massDelistRatio: Number(process.env.RADAR_MASS_DELIST_RATIO ?? 0.5),

    filtersPath: process.env.RADAR_FILTERS ?? null,

    browserUseDir: process.env.RADAR_BROWSER_USE_DIR ?? null,
    browserUsePython: process.env.RADAR_BROWSER_USE_PYTHON ?? "python3",
    browserTimeoutMin: Number(process.env.RADAR_BROWSER_TIMEOUT_MIN ?? 10),
  };
}
