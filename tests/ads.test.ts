import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountInput,
  collectionQuery,
  forceRefresh,
  insightQuery,
  localDay,
} from "../src/lib/ads/queries";
import { adsMeta } from "../src/lib/ads/meta";

test("ads identifiers, opaque pagination and unknown parameters are strictly bounded", () => {
  assert.equal(accountInput.parse("act_2121416662133182"), "2121416662133182");
  assert.equal(
    accountInput.safeParse("1/insights?access_token=x").success,
    false,
  );
  assert.deepEqual(
    collectionQuery(new URLSearchParams("limit=50&after=a%2Bb%3D")),
    { limit: "50", after: "a+b=" },
  );
  for (const query of [
    "limit=51",
    "limit=1e1",
    "limit=0",
    "limit=1&limit=2",
    "fields=access_token",
    "access_token=x",
    "after=",
  ])
    assert.throws(() => collectionQuery(new URLSearchParams(query)));
  assert.throws(() => forceRefresh(new URLSearchParams("refresh=yes")));
});
test("ads date windows use the ad account calendar, exclusive to and inclusive Meta until", () => {
  const now = Date.parse("2026-10-06T01:00:00Z");
  assert.equal(localDay("America/Sao_Paulo", now), "2026-10-05");
  const defaults = insightQuery(
    new URLSearchParams(),
    "America/Sao_Paulo",
    now,
  );
  assert.deepEqual(JSON.parse(defaults.time_range), {
    since: "2026-09-28",
    until: "2026-10-04",
  });
  const q = insightQuery(
    new URLSearchParams(
      "from=2026-10-04&to=2026-10-07&daily=true&level=campaign&breakdown=age,gender",
    ),
    "UTC",
    now,
  );
  assert.deepEqual(JSON.parse(q.time_range), {
    since: "2026-10-04",
    until: "2026-10-06",
  });
  assert.equal(q.time_increment, "1");
  assert.equal(q.action_report_time, "impression");
  for (const invalid of [
    "from=2026-02-30",
    "from=2026-10-06&to=2026-10-06",
    "from=2026-08-01&to=2026-10-01",
    "to=2026-10-08",
    "level=all",
    "daily=1",
    "breakdown=arbitrary",
  ])
    assert.throws(() => insightQuery(new URLSearchParams(invalid), "UTC", now));
});
test("the Ads client never follows redirects, exposes provider messages or accepts oversized responses", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const redirect = adsMeta(async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(
      JSON.stringify({ error: { code: 200, message: "secret" } }),
      { status: 403, headers: { Location: "https://evil.invalid" } },
    );
  });
  await assert.rejects(
    () => redirect.profile("123", "a-token"),
    (e: Error) => e.message === "ads_permission_required",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.method, "GET");
  assert.equal(calls[0]?.options?.redirect, "manual");
  assert.equal(new URL(calls[0]!.url).searchParams.has("access_token"), false);
  const large = adsMeta(async () => new Response("x".repeat(1048577)));
  await assert.rejects(
    () => large.profile("123", "a-token"),
    (e: Error) => e.message === "meta_unavailable",
  );
});
