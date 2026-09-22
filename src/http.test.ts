import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson, HttpError, request, resetHttpGates } from "./http.ts";

/*
 * No network here: every test stubs `globalThis.fetch` and restores it. The
 * point of this suite is the failure taxonomy — blocked vs. malformed vs.
 * oversized vs. not-modified — because those outcomes drive the poller's
 * cooldown, the mass-delist guard and the scoring queue. A test that only
 * proved "a 200 parses" would miss everything this module exists for.
 */

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) =>
    handler(String(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    resetHttpGates();
  }
}

const HEALTHY = () =>
  new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });

test("request: rejects private, credentialed and non-HTTP targets before fetching", async () => {
  await withFetch(HEALTHY, async () => {
    await assert.rejects(() => request("http://127.0.0.1/secret"), /private or link-local/);
    await assert.rejects(() => request("http://169.254.169.254/latest/meta-data"), /private/);
    await assert.rejects(() => request("http://[::1]/"), /private/);
    await assert.rejects(() => request("https://user:pass@example.com/"), /credentials/);
    await assert.rejects(() => request("ftp://example.com/"), /not HTTP/);
  });
});

test("request: IPv4-mapped and IPv4-compatible IPv6 loopback are rejected", async () => {
  // `new URL("http://[::ffff:127.0.0.1]/")` canonicalises to `[::ffff:7f00:1]`,
  // so the dotted form alone is not enough — the hex form must be decoded.
  await withFetch(HEALTHY, async () => {
    await assert.rejects(() => request("http://[::ffff:127.0.0.1]/"), /private/);
    await assert.rejects(() => request("http://[::ffff:7f00:1]/"), /private/);
    await assert.rejects(() => request("http://[::ffff:10.0.0.1]/"), /private/);
    await assert.rejects(() => request("http://[0:0:0:0:0:ffff:7f00:1]/"), /private/);
    await assert.rejects(() => request("http://[::7f00:1]/"), /private/);
    await assert.rejects(() => request("http://[fec0::1]/"), /private/);
    await assert.rejects(() => request("http://[fe80::1]/"), /private/);
    await assert.rejects(() => request("http://[fd12:3456::1]/"), /private/);
  });
});

test("request: an off-allowlist redirect is refused, not followed", async () => {
  await withFetch(
    () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    async () => {
      await assert.rejects(
        () => request("https://good.example/jobs"),
        (e: HttpError) => e.kind === "redirect" && /allowlist/.test(e.message),
      );
    },
  );
});

test("request: a redirect into a private range is refused even with a permissive allowHost", async () => {
  await withFetch(
    () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } }),
    async () => {
      await assert.rejects(
        () => request("https://good.example/jobs", { allowHost: () => true }),
        (e: HttpError) => e.kind === "redirect" && /private/.test(e.message),
      );
    },
  );
});

test("request: same-host redirects are followed and the final URL is reported", async () => {
  let calls = 0;
  await withFetch(
    (url) => {
      calls++;
      if (url.endsWith("/jobs")) {
        return new Response(null, { status: 301, headers: { location: "/jobs/2" } });
      }
      return new Response("board", { status: 200, headers: { "content-type": "text/html" } });
    },
    async () => {
      const res = await request("https://good.example/jobs");
      assert.equal(res.body, "board");
      assert.equal(res.finalUrl, "https://good.example/jobs/2");
      assert.equal(calls, 2);
    },
  );
});

test("request: a 304 is a normal not-modified result with no body", async () => {
  await withFetch(
    () => new Response(null, { status: 304, headers: { etag: 'W/"abc"' } }),
    async () => {
      const res = await request("https://feed.example/rss", { etag: 'W/"abc"' });
      assert.equal(res.status, 304);
      assert.equal(res.body, null);
      assert.equal(res.etag, 'W/"abc"');
    },
  );
});

test("request: a 429 is blocked, with Retry-After preserved in milliseconds", async () => {
  await withFetch(
    () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
    async () => {
      await assert.rejects(
        () => request("https://throttled.example/jobs"),
        (e: HttpError) => e.kind === "blocked" && e.status === 429 && e.retryAfterMs === 120_000,
      );
    },
  );
});

test("request: a 429 with an HTTP-date Retry-After parses to a bounded wait", async () => {
  const when = new Date(Date.now() + 60_000).toUTCString();
  await withFetch(
    () => new Response("", { status: 429, headers: { "retry-after": when } }),
    async () =>
      assert.rejects(
        () => request("https://throttled.example/jobs"),
        (e: HttpError) => e.kind === "blocked" && (e.retryAfterMs ?? 0) > 0,
      ),
  );
});

test("request: a 403 is blocked too, so the poller can pause the domain", async () => {
  await withFetch(
    () => new Response("forbidden", { status: 403 }),
    async () =>
      assert.rejects(
        () => request("https://walled.example/jobs"),
        (e: HttpError) => e.kind === "blocked" && e.status === 403,
      ),
  );
});

test("request: the byte cap is enforced while reading, not after buffering", async () => {
  const big = "x".repeat(200_000);
  await withFetch(
    () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    async () =>
      assert.rejects(
        () => request("https://big.example/feed", { maxBytes: 1_000 }),
        (e: HttpError) => e.kind === "oversized",
      ),
  );
});

test("request: a declared content-length over the cap fails before the body is read", async () => {
  await withFetch(
    () =>
      new Response("small", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "9999999" },
      }),
    async () =>
      assert.rejects(
        () => request("https://big.example/feed", { maxBytes: 1_000 }),
        (e: HttpError) => e.kind === "oversized",
      ),
  );
});

test("request: retries a 500 twice with jitter, then gives up as http", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return new Response("boom", { status: 503, headers: { "retry-after": "0" } });
    },
    async () =>
      assert.rejects(
        () => request("https://flaky.example/jobs"),
        (e: HttpError) => e.kind === "http" && e.status === 503,
      ),
  );
  assert.equal(calls, 3, "bounded retries: three attempts total");
});

test("request: a 404 is not retried", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return new Response("gone", { status: 404 });
    },
    async () => assert.rejects(() => request("https://dead.example/jobs")),
  );
  assert.equal(calls, 1);
});

test("request: network errors retry, then surface as network kind", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      throw new TypeError("fetch failed");
    },
    async () =>
      assert.rejects(
        () => request("https://unreachable.example/jobs"),
        (e: HttpError) => e.kind === "network" && /fetch failed/.test(e.message),
      ),
  );
  assert.equal(calls, 3);
});

test("request: per-host concurrency caps parallel requests to the same domain", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;

  await withFetch(
    async () => {
      calls++;
      if (calls === 1) await gate;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    },
    async () => {
      const first = request("https://capped.example/a", { perHost: 1 });
      await new Promise((r) => setTimeout(r, 10));
      const second = request("https://capped.example/b", { perHost: 1 });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls, 1, "the second request waits for the host slot");
      release!();
      await Promise.all([first, second]);
      assert.equal(calls, 2);
    },
  );
});

test("fetchJson: HTML at a JSON endpoint is malformed, never zero jobs", async () => {
  await withFetch(
    () => new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () =>
      assert.rejects(
        () => fetchJson("https://api.example/jobs"),
        (e: HttpError) => e.kind === "malformed" && /expected JSON/.test(e.message),
      ),
  );
});

test("fetchJson: invalid JSON in a JSON response is malformed", async () => {
  await withFetch(
    () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    async () =>
      assert.rejects(
        () => fetchJson("https://api.example/jobs"),
        (e: HttpError) => e.kind === "malformed",
      ),
  );
});

test("fetchJson: a 304 yields a null body rather than a parse error", async () => {
  await withFetch(
    () => new Response(null, { status: 304 }),
    async () => {
      const res = await fetchJson("https://api.example/jobs", { etag: 'W/"1"' });
      assert.equal(res.status, 304);
      assert.equal(res.body, null);
    },
  );
});
