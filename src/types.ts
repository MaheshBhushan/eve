export type PostingState = "open" | "closed";
/**
 * Every source the registry can serve. Split by what they are, because the
 * distinction decides whether an absence may be read as a closure:
 *
 *  - board sources (`greenhouse`…`smartrecruiters`) list one employer's open
 *    roles in full, so a snapshot is authoritative;
 *  - `arbeitsagentur` is a national *search*, complete only while the result set
 *    stays under its cap — it throws rather than return a truncated snapshot;
 *  - `stepstone`, `indeed`, `xing`, `linkedin` are direct-HTTP board searches and
 *    `browser` a driven-browser one; all are ranked, capped searches that can
 *    never claim completeness.
 */
export type SourceKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "personio"
  | "smartrecruiters"
  | "workday"
  | "successfactors"
  | "arbeitsagentur"
  | "stepstone"
  | "indeed"
  | "xing"
  | "linkedin"
  | "browser";

export type EventType =
  | "posting_opened"
  | "posting_closed"
  | "posting_reposted"
  | "fresh_opening"
  | "high_fit"
  | "vanished_while_claimed"
  | "deadline"
  | "stale";

export interface SourceRow {
  id: number;
  kind: SourceKind;
  ident: string;
  label: string;
  etag: string | null;
  last_poll: string | null;
  fail_count: number;
  added_at: string;
}

export interface PostingRow {
  id: number;
  source_id: number;
  key: string;
  external_id: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  department: string | null;
  url: string;
  posted_at: string;
  /** 1 when the board stated a publish date; 0 when we substituted first_seen. */
  posted_at_exact: number;
  closes_at: string | null;
  first_seen: string;
  last_seen: string;
  state: PostingState;
  closed_at: string | null;
  repost_count: number;
  description: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  fit_scored_at: string | null;
  message_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  applied_at: string | null;
  stale_notified_at: string | null;
  deadline_notified_at: string | null;
}

export interface EventRow {
  id: number;
  source_id: number;
  posting_id: number;
  type: EventType;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
}

/**
 * One posting as returned by a source adapter, before normalisation. Every
 * adapter maps its board's JSON down to this; nothing downstream knows or
 * cares which board a posting came from.
 */
export interface FetchedPosting {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  department: string | null;
  url: string;
  /** ISO time the board says it was published, or null if it doesn't say. */
  postedAt: string | null;
  closesAt: string | null;
  description: string | null;
}

/**
 * Shape written by the poller. The omitted columns are ours, not the board's:
 * claims, fit scores, message ids and notify guards must survive every poll.
 */
export type PostingUpsert = Omit<
  PostingRow,
  | "id"
  | "first_seen"
  | "last_seen"
  | "state"
  | "closed_at"
  | "repost_count"
  | "fit_score"
  | "fit_reason"
  | "fit_scored_at"
  | "message_id"
  | "claimed_by"
  | "claimed_at"
  | "applied_at"
  | "stale_notified_at"
  | "deadline_notified_at"
>;
