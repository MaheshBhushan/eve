"""Run one job-board search in a real browser and print the results as JSON.

Called by src/sources/browser.ts, never by a human directly:

    python board_search.py --site linkedin --query "machine learning engineer" \
                           --location Berlin --limit 50

CONTRACT WITH THE NODE SIDE
  stdout : exactly ONE JSON array, and nothing else. Each element uses the
           FetchedPosting field names from src/types.ts:
             externalId, title, company, location, remote, department,
             url, postedAt, closesAt, description
  stderr : everything else -- agent logs, progress, tracebacks. All logging is
           pinned to stderr precisely so a stray log line can never corrupt the
           JSON document on stdout.
  exit   : 0 with a valid array, or non-zero. Never 0 with junk.

WHAT THIS IS NOT. A search page is a ranked, paginated slice, not the complete
set of open jobs. The Node adapter marks itself partial for that reason; this
script makes no attempt to be exhaustive and must not be "fixed" to claim it is.

DATES. The agent is told to copy the site's posted-date text VERBATIM ("2 days
ago", "vor 3 Tagen", "Just posted") and never to guess an absolute date. The
conversion to ISO happens down here in `_iso_from_relative`, in ordinary code we
can reason about. When the text is missing or unparseable, postedAt is null --
the system distinguishes a stated publish date from a substituted one, and the
freshness alert only fires on stated ones, so a fabricated date would turn into
a false "fresh match" ping. Never invent one.

REQUIREMENTS. browser-use is not vendored and its checkout has no virtualenv.
Create one and point the adapter at it:

    python3 -m venv .venv
    .venv/bin/pip install browser-use
    .venv/bin/playwright install chromium

    export RADAR_BROWSER_USE_DIR=/path/to/browser-use
    export RADAR_BROWSER_USE_PYTHON=/path/to/browser-use/.venv/bin/python

LLM credentials come from the environment (see `_make_llm`): either
RADAR_BROWSER_API_KEY (+ RADAR_BROWSER_BASE_URL, OpenAI-compatible) or
ANTHROPIC_API_KEY.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, quote_plus, urlparse

# Every logger goes to stderr. stdout belongs to the JSON array alone.
logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                    format="%(asctime)s  %(name)s  %(levelname)-7s  %(message)s")
log = logging.getLogger("board_search")

SITES = ("linkedin", "indeed", "stepstone")


# ---------------------------------------------------------------- search URL

def _search_url(site: str, query: str, location: str) -> str:
    """The site's own search URL. Handing the agent a direct URL rather than
    asking it to drive the homepage search box removes several steps that
    reliably break on cookie walls and autocomplete dropdowns."""
    q, l = quote_plus(query), quote_plus(location)
    if site == "linkedin":
        return f"https://www.linkedin.com/jobs/search/?keywords={q}&location={l}"
    if site == "indeed":
        return f"https://www.indeed.com/jobs?q={q}&l={l}"
    if site == "stepstone":
        return f"https://www.stepstone.de/jobs?what={q}&where={l}"
    raise ValueError(f"unknown site {site!r}")


# ------------------------------------------------------------- posted dates

#: "2 days ago", "vor 3 Tagen", "il y a 2 jours" -- number + unit, any order.
_UNITS = {
    "minute": "minutes", "minuten": "minutes", "min": "minutes",
    "hour": "hours", "hours": "hours", "stunde": "hours", "stunden": "hours", "std": "hours",
    "day": "days", "days": "days", "tag": "days", "tagen": "days", "jour": "days", "jours": "days",
    "week": "weeks", "weeks": "weeks", "woche": "weeks", "wochen": "weeks",
    "month": "months", "months": "months", "monat": "months", "monaten": "months",
}
_NOW_WORDS = ("just posted", "just now", "today", "heute", "gerade", "neu",
              "aujourd'hui", "hace instantes")
_YESTERDAY_WORDS = ("yesterday", "gestern", "hier")


def _iso_from_relative(text: str | None, now: datetime | None = None) -> str | None:
    """Convert the site's own posted-date wording to an ISO timestamp.

    Returns None when there is nothing usable -- including for the "30+ days
    ago" bucket, which is a floor and not a date, and for absolute-looking
    strings we cannot parse confidently. None is always the safe answer here.
    """
    if not text:
        return None
    now = now or datetime.now(timezone.utc)
    t = text.strip().lower()
    if not t:
        return None

    # Already an ISO date from a structured field (some cards expose datetime=).
    m = re.match(r"^(\d{4}-\d{2}-\d{2})(?:[t ][\d:]+)?", t)
    if m:
        try:
            d = datetime.fromisoformat(m.group(1)).replace(tzinfo=timezone.utc)
            return d.isoformat()
        except ValueError:
            return None

    if any(w in t for w in _NOW_WORDS):
        return now.isoformat()
    if any(w in t for w in _YESTERDAY_WORDS):
        return (now - timedelta(days=1)).isoformat()

    # "30+ days ago" is a bucket meaning "older than a month". Pretending it is
    # exactly 30 days old would date a six-month-old posting to last month.
    if "+" in t:
        return None

    m = re.search(r"(\d+)\s*([a-zä-ü']+)", t) or re.search(r"([a-zä-ü']+)\s*(\d+)", t)
    if not m:
        return None
    a, b = m.group(1), m.group(2)
    num, word = (a, b) if a.isdigit() else (b, a)
    unit = _UNITS.get(word.rstrip("s.")) or _UNITS.get(word)
    if not unit:
        return None
    n = int(num)
    days = {"minutes": n / 1440, "hours": n / 24, "days": n,
            "weeks": n * 7, "months": n * 30}[unit]
    return (now - timedelta(days=days)).isoformat()


# --------------------------------------------------------------- identity

def _external_id(site: str, url: str) -> str:
    """A stable per-posting id.

    Prefer the site's own numeric job id out of the URL: search URLs carry
    tracking junk that changes every load, so hashing the whole URL would make
    the same job look new on every poll. Hash only as a last resort.
    """
    try:
        p = urlparse(url)
        qs = parse_qs(p.query)
    except ValueError:
        p, qs = None, {}

    if site == "linkedin":
        for key in ("currentJobId", "jobId"):
            if qs.get(key):
                return qs[key][0]
        m = re.search(r"/jobs/view/(?:[^/]*-)?(\d+)", url)
        if m:
            return m.group(1)
    elif site == "indeed":
        for key in ("jk", "vjk"):
            if qs.get(key):
                return qs[key][0]
    elif site == "stepstone":
        m = re.search(r"--(\d+)-", url) or re.search(r"/(\d{6,})(?:[/?]|$)", url)
        if m:
            return m.group(1)

    canonical = f"{p.netloc}{p.path}" if p else url
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------- LLM

def _make_llm():
    """OpenAI-compatible gateway by default, Anthropic if that key is the one
    present. Credentials are passed explicitly so browser-use needs no .env of
    its own."""
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    api_key = os.environ.get("RADAR_BROWSER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("RADAR_BROWSER_MODEL", "gpt-4.1-mini")

    if api_key:
        from browser_use.llm.openai.chat import ChatOpenAI  # type: ignore
        # An explicit temperature is required: browser-use otherwise sends
        # temperature=null, which several gateways reject with a 400.
        return ChatOpenAI(
            model=model,
            base_url=os.environ.get("RADAR_BROWSER_BASE_URL") or None,
            api_key=api_key,
            temperature=float(os.environ.get("RADAR_BROWSER_TEMPERATURE", "0.0")),
        )
    if anthropic_key:
        from browser_use.llm.anthropic.chat import ChatAnthropic  # type: ignore
        return ChatAnthropic(
            model=os.environ.get("RADAR_BROWSER_MODEL", "claude-sonnet-4-5"),
            api_key=anthropic_key,
        )
    raise RuntimeError(
        "no LLM credentials for the browser adapter: set RADAR_BROWSER_API_KEY "
        "(with RADAR_BROWSER_BASE_URL for an OpenAI-compatible gateway) or "
        "ANTHROPIC_API_KEY."
    )


def _build_task(site: str, query: str, location: str, limit: int) -> str:
    where = location or "any location"
    return f"""You are collecting job search results from {site}. You are READING
only: do not apply, do not message anyone, do not click "Easy Apply", and do not
create or modify anything.

1. Open this search page:
   {_search_url(site, query, location)}
   It is a search for "{query}" in {where}.
2. Dismiss any cookie banner or dialog that covers the results.
3. Scroll the results list and collect up to {limit} job results. Load more
   pages / scroll further only until you have {limit} results or the list ends.
4. For EACH result, record exactly these fields:
   - title:      the job title as shown
   - company:    the hiring company name
   - location:   the location text as shown (empty string if none)
   - url:        the link to that specific job posting (the href of the result)
   - posted_text: the posted-date text the site displays for that result,
                  copied VERBATIM, e.g. "2 days ago", "vor 3 Tagen",
                  "Just posted", "30+ days ago". Do NOT convert it to a
                  calendar date, do NOT estimate, and do NOT infer it from
                  anything else. If the result shows no posted date at all, use
                  an empty string. An invented date is worse than no date.

IF YOU ARE BLOCKED — a login wall, a CAPTCHA, a "you've been rate limited" or
"unusual activity" page — STOP IMMEDIATELY and report the blocking page in one
sentence. Do not try to work around it, do not solve a CAPTCHA, do not open a
different site. Being blocked is a valid, expected outcome.

FINISH by returning your result as JSON only, in this exact shape and nothing
else:
{{"results": [{{"title": "...", "company": "...", "location": "...",
  "url": "https://...", "posted_text": "..."}}]}}
Report only jobs you actually saw on the page. Never fill a field with a guess;
use an empty string instead."""


# ------------------------------------------------------------------- runner

def _extract_json_object(text: str) -> dict:
    """Pull the result object out of the agent's final message.

    Agents wrap JSON in prose or fences however they like, so take the outermost
    braces. Anything that doesn't yield an object is an error, not an empty
    result -- "no jobs found" and "the agent rambled" must not look alike.
    """
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise RuntimeError(f"agent returned no JSON object: {text[:300]!r}")
    obj = json.loads(text[start:end + 1])
    if not isinstance(obj, dict) or not isinstance(obj.get("results"), list):
        raise RuntimeError("agent JSON has no `results` array")
    return obj


def _to_postings(site: str, obj: dict) -> list[dict]:
    out, seen = [], set()
    for r in obj["results"]:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or "").strip()
        title = str(r.get("title") or "").strip()
        company = str(r.get("company") or "").strip()
        # A result missing any of these is unusable downstream; drop it rather
        # than emit a posting the Node validator will reject wholesale.
        if not (url.startswith("http") and title and company):
            log.warning("dropping incomplete result: %r", r)
            continue
        ext = _external_id(site, url)
        if ext in seen:  # search pages repeat promoted rows across scrolls
            continue
        seen.add(ext)
        loc = str(r.get("location") or "").strip()
        out.append({
            "externalId": ext,
            "title": title,
            "company": company,
            "location": loc or None,
            "remote": True if re.search(r"\bremote\b", loc, re.I) else None,
            "department": None,
            "url": url,
            "postedAt": _iso_from_relative(str(r.get("posted_text") or "")),
            "closesAt": None,
            "description": None,
        })
    return out


async def _run(site: str, query: str, location: str, limit: int) -> list[dict]:
    browser_use_dir = os.environ.get("RADAR_BROWSER_USE_DIR")
    if browser_use_dir:
        sys.path.insert(0, browser_use_dir)
    try:
        from browser_use import Agent  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            f"browser-use is not importable (RADAR_BROWSER_USE_DIR={browser_use_dir}). "
            "Create a venv in that checkout: python3 -m venv .venv && "
            ".venv/bin/pip install browser-use && .venv/bin/playwright install "
            "chromium, then point RADAR_BROWSER_USE_PYTHON at .venv/bin/python."
        ) from e

    import inspect
    kwargs = {"task": _build_task(site, query, location, limit), "llm": _make_llm()}
    sig = inspect.signature(Agent.__init__)
    # Reuse a persistent profile so an existing LinkedIn login carries over --
    # a logged-out LinkedIn search is mostly a login wall.
    user_data_dir = os.environ.get("RADAR_BROWSER_USER_DATA_DIR")
    if user_data_dir and "browser_profile" in sig.parameters:
        try:
            from browser_use import BrowserProfile  # type: ignore
            kwargs["browser_profile"] = BrowserProfile(
                user_data_dir=user_data_dir,
                headless=os.environ.get("RADAR_BROWSER_HEADLESS", "1") != "0",
            )
        except Exception:  # an ephemeral profile still works, just logged out
            log.warning("could not build BrowserProfile; using an ephemeral one")

    result = await Agent(**kwargs).run()
    final = None
    for attr in ("final_result", "extracted_content"):
        fn = getattr(result, attr, None)
        if callable(fn):
            final = fn()
            if final:
                break
    return _to_postings(site, _extract_json_object(final if isinstance(final, str) else str(result)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="One job-board search -> JSON on stdout")
    ap.add_argument("--site", required=True, choices=SITES)
    ap.add_argument("--query", required=True)
    ap.add_argument("--location", default="")
    ap.add_argument("--limit", type=int, default=50)
    args = ap.parse_args(argv)

    log.info("searching %s for %r in %r", args.site, args.query, args.location or "anywhere")
    postings = asyncio.run(_run(args.site, args.query, args.location, args.limit))
    log.info("collected %d results", len(postings))
    # The one and only thing ever written to stdout.
    sys.stdout.write(json.dumps(postings, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # a clean non-zero exit, never junk on stdout
        log.error("board_search failed: %s", exc, exc_info=True)
        raise SystemExit(1)
