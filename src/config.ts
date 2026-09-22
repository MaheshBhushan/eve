/** Single-channel deployment: one DISCORD_CHANNEL_ID for every watched source. */
export interface Config {
  fitProvider?: "claude" | "typesafe";
  fitConfidence?: number;
  matchesOnly?: boolean;
  fitConcurrency?: number;
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

  /* -------------------------------------------------------- openings --- */
  /**
   * A newly seen posting whose stated publish time is within this many hours
   * is pinged as a `fresh_opening`, regardless of fit. This is the
   * be-first-to-apply signal; it needs no LLM and no description.
   */
  freshPingHours: number;
  /**
   * A newly seen posting older than this (by stated publish time) is stored
   * and shown on the dashboard but queues no Discord event at all. Ranked
   * search pages churn: a week-old posting drifting back into the visible
   * window is not news, and without this gate it would be announced as one.
   */
  alertMaxAgeHours: number;

  /* ---------------------------------------------------------- sweeps --- */
  /** Claimed but not applied for this long -> a nudge. */
  staleDays: number;
  /** Ping this many days before a stated application deadline. */
  deadlineDays: number;
  /**
   * Consecutive poll failures before a source is marked muted. A muted source
   * is not abandoned: it is probed on the capped backoff (up to 6h), so a
   * temporary outage recovers on its own while a genuinely dead board costs a
   * few requests a day instead of a request every cycle.
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
   * means no extra constraints; mandatory role targeting still applies.
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

  /* -------------------------------------------------------- dashboard --- */
  /** Port the live job dashboard HTTP server listens on. */
  dashboardPort: number;
  /** Bind address for the dashboard server. Loopback by default. */
  dashboardBind: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  const fitProvider = process.env.RADAR_FIT_PROVIDER ?? "claude";
  if (fitProvider !== "claude" && fitProvider !== "typesafe") throw new Error("RADAR_FIT_PROVIDER must be claude or typesafe");
  const fitConfidence = Number(process.env.RADAR_FIT_CONFIDENCE ?? 0.8);
  if (!Number.isFinite(fitConfidence) || fitConfidence < 0 || fitConfidence > 1) throw new Error("RADAR_FIT_CONFIDENCE must be between 0 and 1");
  const fitConcurrency = Number(process.env.RADAR_FIT_CONCURRENCY ?? 3);
  if (!Number.isInteger(fitConcurrency) || fitConcurrency < 1 || fitConcurrency > 10) throw new Error("RADAR_FIT_CONCURRENCY must be an integer from 1 to 10");
  // Explicit env wins; unset defaults to matches-only for the TypeSafe path,
  // because profile matching is the reason that provider exists. An explicit
  // `false` re-enables raw opening/repost alerts alongside match alerts —
  // useful while the strict match gates are being evaluated on real data.
  const matchesOnly =
    process.env.RADAR_MATCHES_ONLY === undefined
      ? fitProvider === "typesafe"
      : process.env.RADAR_MATCHES_ONLY === "true";
  if (matchesOnly && fitProvider !== "typesafe") throw new Error("Matches-only mode requires typesafe scoring with confidence");
  if (fitProvider === "typesafe" && (!process.env.TYPESAFE_API_KEY || !process.env.RADAR_PROFILE)) throw new Error("TypeSafe scoring requires TYPESAFE_API_KEY and RADAR_PROFILE");
  return {
    fitProvider, fitConfidence, fitConcurrency, matchesOnly,
    dbPath: process.env.RADAR_DB ?? "eve.db",
    discordToken: req("DISCORD_TOKEN"),
    discordChannelId: req("DISCORD_CHANNEL_ID"),
    digestThreshold: Number(process.env.RADAR_DIGEST_THRESHOLD ?? 5),
    pingTarget: process.env.RADAR_PING ? `<@${process.env.RADAR_PING}>` : "@here",

    profilePath: process.env.RADAR_PROFILE ?? null,
    fitModel: fitProvider === "typesafe" ? (process.env.RADAR_JEV_MODEL ?? "jev-1.13.0") : (process.env.RADAR_FIT_MODEL ?? "sonnet"),
    fitThreshold: Number(process.env.RADAR_FIT_THRESHOLD ?? 75),
    freshHours: Number(process.env.RADAR_FRESH_HOURS ?? 48),
    fitBudget: Number(process.env.RADAR_FIT_BUDGET ?? 25),

    freshPingHours: Number(process.env.RADAR_FRESH_PING_HOURS ?? 3),
    alertMaxAgeHours: Number(process.env.RADAR_ALERT_MAX_AGE_HOURS ?? 24),

    staleDays: Number(process.env.RADAR_STALE_DAYS ?? 7),
    deadlineDays: Number(process.env.RADAR_DEADLINE_DAYS ?? 3),
    maxFailures: Number(process.env.RADAR_MAX_FAILURES ?? 5),
    massDelistRatio: Number(process.env.RADAR_MASS_DELIST_RATIO ?? 0.5),

    filtersPath: process.env.RADAR_FILTERS ?? null,

    browserUseDir: process.env.RADAR_BROWSER_USE_DIR ?? null,
    browserUsePython: process.env.RADAR_BROWSER_USE_PYTHON ?? "python3",
    browserTimeoutMin: Number(process.env.RADAR_BROWSER_TIMEOUT_MIN ?? 10),

    dashboardPort: Number(process.env.RADAR_DASHBOARD_PORT ?? 8787),
    dashboardBind: process.env.RADAR_DASHBOARD_BIND ?? "127.0.0.1",
  };
}
