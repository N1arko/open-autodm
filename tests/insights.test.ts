import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountQuery,
  audienceQuery,
  date,
  range,
  refresh,
  DAY,
} from "../src/lib/insights/queries";
import { insightsMeta } from "../src/lib/insights/meta";
import {
  buildOAuthUrl,
  INSIGHTS_SCOPE,
  PUBLISHING_SCOPE,
} from "../src/lib/instagram/oauth";
const response = (data: unknown, status = 200) =>
  Response.json(data, { status });
test("strict UTC ranges, calendar dates, safe metric allowlist and independent OAuth scopes", () => {
  assert.throws(() => date("2026-02-30"));
  assert.throws(() => date("2026-10-05T00:00:00Z"));
  const now = date("2026-10-05") + DAY / 2;
  assert.deepEqual(
    range(new URLSearchParams("from=2026-10-01&to=2026-10-05"), now),
    { from: "2026-10-01", to: "2026-10-05" },
  );
  assert.throws(() =>
    range(new URLSearchParams("from=2026-01-01&to=2026-10-05"), now),
  );
  assert.throws(() =>
    accountQuery(new URLSearchParams("metrics=access_token")),
  );
  assert.throws(() =>
    audienceQuery(new URLSearchParams("breakdown=unsupported")),
  );
  assert.throws(() => refresh(new URLSearchParams("refresh=anything")));
  const scope = (pub: boolean, insight: boolean) =>
    new URL(
      buildOAuthUrl(
        "123",
        "https://example.com/callback",
        "test",
        pub,
        insight,
      ),
    ).searchParams
      .get("scope")!
      .split(",");
  assert.ok(!scope(false, false).includes(INSIGHTS_SCOPE));
  assert.ok(scope(false, true).includes(INSIGHTS_SCOPE));
  assert.ok(!scope(false, true).includes(PUBLISHING_SCOPE));
  assert.equal(scope(true, true).length, 5);
});
test("known metric rejection splits requests while permission, rate and server failures stay errors", async () => {
  let calls = 0;
  const meta = insightsMeta(async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fake-token",
    );
    assert.equal(url.searchParams.has("access_token"), false);
    const names = url.searchParams.get("metric")!.split(",");
    if (names.includes("ig_reels_avg_watch_time"))
      return response({ error: { code: 100 } }, 400);
    return response({
      data: names.map((name) => ({
        name,
        period: "lifetime",
        values: [{ value: 0 }],
      })),
    });
  });
  const out = await meta.insights("123", "fake-token", {
    kind: "media",
    metrics: ["views", "ig_reels_avg_watch_time"],
  });
  assert.equal(calls, 3);
  assert.equal(out.metrics[0]!.values![0]!.value, 0);
  assert.deepEqual(out.unavailable_metrics, [
    { name: "ig_reels_avg_watch_time", reason: "provider_rejected" },
  ]);
  for (const [status, code, expected] of [
    [400, 200, "insights_permission_required"],
    [429, 4, "meta_rate_limited"],
    [500, 100, "meta_unavailable"],
    [400, 190, "account_unavailable"],
  ] as const) {
    let count = 0;
    const failed = insightsMeta(async () => {
      count++;
      return response({ error: { code } }, status);
    });
    await assert.rejects(
      () =>
        failed.insights("123", "token", {
          kind: "media",
          metrics: ["views", "reach"],
        }),
      { message: expected },
    );
    assert.equal(count, 1);
  }
});
test("empty and malformed provider values, oversized responses and missing media ownership fail safely", async () => {
  const empty = insightsMeta(async () =>
    response({ data: [{ name: "views", period: "lifetime", values: [] }] }),
  );
  assert.deepEqual(
    (await empty.insights("123", "t", { kind: "media", metrics: ["views"] }))
      .unavailable_metrics,
    [{ name: "views", reason: "no_data" }],
  );
  const bad = insightsMeta(async () =>
    response({
      data: [{ name: "views", period: "lifetime", values: [{ value: "5" }] }],
    }),
  );
  await assert.rejects(
    () => bad.insights("123", "t", { kind: "media", metrics: ["views"] }),
    { message: "meta_invalid_response" },
  );
  const huge = insightsMeta(async () => new Response("x".repeat(300000)));
  await assert.rejects(() => huge.profile("123", "t"), {
    message: "meta_unavailable",
  });
  const foreign = insightsMeta(async () =>
    response({
      id: "456",
      media_type: "VIDEO",
      timestamp: new Date().toISOString(),
    }),
  );
  await assert.rejects(() => foreign.media("123", "456", "t"), {
    message: "media_not_found",
  });
});

test("different Instagram owner IDs require the token to prove both account identities", async () => {
  for (const owner of ["789", { id: "789" }]) {
    for (const identity of [
      { id: "789", user_id: "123" },
      { id: "789", user_id: "999" },
      { id: "999", user_id: "123" },
      { id: "789" },
    ]) {
      const paths: string[] = [];
      const meta = insightsMeta(async (input, init) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer token",
        );
        if (url.pathname.endsWith("/me")) {
          assert.equal(url.searchParams.get("fields"), "id,user_id");
          return response(identity);
        }
        return response({
          id: "456",
          owner,
          media_type: "VIDEO",
          timestamp: new Date().toISOString(),
        });
      });
      if (identity.id === "789" && identity.user_id === "123")
        assert.equal((await meta.media("123", "456", "token")).id, "456");
      else
        await assert.rejects(() => meta.media("123", "456", "token"), {
          message: "media_not_found",
        });
      assert.deepEqual(paths, ["/v26.0/456", "/v26.0/me"]);
    }
  }
});
