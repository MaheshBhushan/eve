import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";

const config = loadConfig();
const db = openDb(config.dbPath);

interface DashRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  url: string;
  first_seen: string;
  posted_at: string;
  posted_at_exact: number;
  kind: string;
  label: string;
}

const QUERY = `
  SELECT p.id, p.title, p.company, p.location, p.url, p.first_seen,
         p.posted_at, p.posted_at_exact, s.kind, s.label
    FROM postings p JOIN sources s ON s.id = p.source_id
   WHERE p.state = 'open'
   ORDER BY p.first_seen DESC
   LIMIT 300`;

function listPostings(): DashRow[] {
  return db.prepare(QUERY).all() as unknown as DashRow[];
}

function watermark(): string {
  const row = db
    .prepare("SELECT MAX(id) AS maxId, COUNT(*) AS n FROM postings WHERE state = 'open'")
    .get() as { maxId: number | null; n: number };
  return `${row.maxId ?? 0}:${row.n}`;
}

function page(): string {
  const json = JSON.stringify(listPostings()).replace(/</g, "\\u003c");
  return PAGE_TEMPLATE.split("__INITIAL__").join(json);
}

const PAGE_TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><title>LIVE JOBS</title>
<style>
  :root { color-scheme: dark; }
  body { background: #0b0d10; color: #e6e6e6; font: 15px/1.4 -apple-system, system-ui, sans-serif; margin: 0; }
  header { padding: 16px 24px; border-bottom: 1px solid #22262b; display: flex; justify-content: space-between; align-items: baseline; }
  header h1 { margin: 0; font-size: 18px; letter-spacing: 0.05em; }
  #updated { color: #7a8087; font-size: 13px; }
  #list { padding: 16px 24px; display: grid; gap: 10px; }
  .card { background: #14171a; border: 1px solid #22262b; border-radius: 8px; padding: 12px 14px; }
  .card a { color: #7cc4ff; text-decoration: none; font-weight: 600; font-size: 15px; }
  .card a:hover { text-decoration: underline; }
  .meta { color: #a3a9b0; font-size: 13px; margin-top: 4px; }
  .badges { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: #22262b; color: #c9ced4; }
  .badge.new { background: #1f4d2e; color: #7fe89a; }
  .badge.source { background: #24344d; color: #9ec2ff; }
</style></head>
<body>
<header><h1>LIVE JOBS</h1><span id="updated">Updated 0 sec ago</span></header>
<div id="list">Loading…</div>
<script>
let lastFetch = Date.now();

function relTime(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso + "Z").getTime()) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function render(rows) {
  const list = document.getElementById("list");
  if (rows.length === 0) { list.textContent = "No open postings."; return; }
  const now = Date.now();
  list.innerHTML = rows.map(function (r) {
    const isNew = (now - new Date(r.first_seen + "Z").getTime()) < 3600 * 1000;
    const posted = r.posted_at_exact ? '<span class="badge">Posted ' + relTime(r.posted_at) + '</span>' : "";
    return '<div class="card">' +
      '<a href="' + r.url + '" target="_blank" rel="noopener">' + r.title + '</a>' +
      '<div class="meta">' + r.company + (r.location ? ' · ' + r.location : '') + '</div>' +
      '<div class="badges">' +
        '<span class="badge source">' + r.kind + '</span>' +
        '<span class="badge">' + r.label + '</span>' +
        (isNew ? '<span class="badge new">NEW</span>' : '') +
        posted +
        '<span class="badge">Detected ' + relTime(r.first_seen) + '</span>' +
      '</div></div>';
  }).join("");
}

function refresh() {
  fetch("/api/postings").then(function (r) { return r.json(); }).then(function (rows) {
    render(rows);
    lastFetch = Date.now();
  });
}

setInterval(function () {
  document.getElementById("updated").textContent =
    "Updated " + Math.floor((Date.now() - lastFetch) / 1000) + " sec ago";
}, 1000);

render(__INITIAL__);
refresh();

const es = new EventSource("/events");
es.addEventListener("change", refresh);
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }
  if (req.url === "/api/postings") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listPostings()));
    return;
  }
  if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let last = watermark();
    const poll = setInterval(() => {
      const now = watermark();
      if (now !== last) {
        last = now;
        res.write("event: change\ndata: {}\n\n");
      }
    }, 5000);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25000);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(keepalive);
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(config.dashboardPort, config.dashboardBind, () => {
  console.log(`dashboard listening on http://${config.dashboardBind}:${config.dashboardPort}`);
});
