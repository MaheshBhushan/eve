/** SQL gate shared by automatic scoring, listings and discovery delivery. */
export function recentPostingSql(alias = "", hours = process.env.RADAR_RECENT_HOURS): string {
  if (hours === undefined) return "1";
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) throw new Error("RADAR_RECENT_HOURS must be a positive number");
  const prefix = alias ? `${alias}.` : "";
  // Unknown publication dates use discovery time; known old jobs stay old.
  return `julianday(CASE WHEN ${prefix}posted_at_exact = 1 THEN ${prefix}posted_at ELSE ${prefix}first_seen END) >= julianday('now', '-${value} hours')`;
}
