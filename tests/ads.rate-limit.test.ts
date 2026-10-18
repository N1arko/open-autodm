import { test } from "node:test";
import assert from "node:assert/strict";
import {
  metaUsage,
  retryAfter,
  rateLimitDetails,
  retryDelay,
} from "../src/lib/ads/rateLimit";
import { apiRoute } from "../src/lib/transport/api";
import { adsMeta } from "../src/lib/ads/meta";
import { writeMeta } from "../src/lib/ads/writeMeta";
import { actionInput } from "../src/lib/ads/actions";
const now = Date.parse("2026-10-18T00:32:28.000Z");
const headers = new Headers({
  "retry-after": "120",
  "x-app-usage": JSON.stringify({
    call_count: 70,
    total_cputime: 3,
    total_time: 7,
    access_token: "private-app-secret",
  }),
  "x-ad-account-usage": JSON.stringify({
    acc_id_util_pct: 110,
    reset_time_duration: 500,
    ads_api_access_tier: "development_access",
    account_id: "private-account-id",
  }),
  "x-business-use-case-usage": JSON.stringify({
    "private-business-id": [
      {
        type: "ads_management",
        call_count: 25,
        total_cputime: 10,
        total_time: 30,
        estimated_time_to_regain_access: 10,
        ads_api_access_tier: "development_access",
        secret: "private-business-secret",
      },
    ],
  }),
});
test("usage exposes only bounded whitelisted signals and distinguishes minutes from seconds", () => {
  const usage = metaUsage(headers, now)!;
  assert.equal(usage.observed_at, "2026-10-18T00:32:28.000Z");
  assert.equal(usage.ad_account!.acc_id_util_pct, 110);
  assert.equal(usage.ad_account!.reset_time_duration_seconds, 500);
  assert.equal(usage.business![0]!.estimated_regain_access_minutes, 10);
  assert.equal(usage.business![0]!.access_tier, "development_access");
  assert.equal(JSON.stringify(usage).includes("private-"), false);
  assert.deepEqual(retryAfter(headers, now, 17), {
    seconds: 600,
    source: "business_usage",
  });
  assert.deepEqual(
    retryAfter(
      new Headers({ "x-ad-account-usage": '{"reset_time_duration":500}' }),
      now,
      17,
    ),
    { seconds: 500, source: "ad_account_usage" },
  );
});
test("missing, zero, malformed and oversized usage are observations, not evidence of restored access", () => {
  for (const value of [
    "broken",
    "[]",
    "null",
    "x".repeat(17000),
    "{}",
    '{"x":[null,3,"bad",{"estimated_time_to_regain_access":"secret","type":{"toString":"bad"}}]}',
  ]) {
    const retry = rateLimitDetails(
      new Headers({ "x-business-use-case-usage": value }),
      17,
      now,
    );
    assert.equal(retry.seconds, 300);
    assert.equal(retry.source, "default");
    assert.equal(retry.policy!.recovery_time_known, false);
  }
  const zero = rateLimitDetails(
    new Headers({
      "x-business-use-case-usage":
        '{"x":[{"estimated_time_to_regain_access":0}]}',
    }),
    17,
    now,
  );
  assert.equal(zero.seconds, 300);
  assert.equal(zero.usage!.business![0]!.estimated_regain_access_minutes, 0);
  assert.deepEqual(retryAfter(new Headers(), now, 4), {
    seconds: 60,
    source: "default",
  });
  assert.deepEqual(
    retryAfter(
      new Headers({ "retry-after": new Date(now + 45000).toUTCString() }),
      now,
      17,
    ),
    { seconds: 45, source: "retry_after" },
  );
  assert.equal(
    retryAfter(new Headers({ "retry-after": "99999999999" }), now, 17).seconds,
    86400,
  );
});
test("caller backoff grows with consecutive failures, bounds jitter and respects longer provider estimates", () => {
  const policy = rateLimitDetails(new Headers(), 17, now).policy!;
  assert.deepEqual(
    [1, 2, 3, 4, 5, 20].map((n) => retryDelay(policy, n, () => 0)),
    [300, 600, 1200, 2400, 3600, 3600],
  );
  assert.equal(
    retryDelay(policy, 2, () => 1),
    720,
  );
  assert.equal(
    retryDelay(policy, 2, () => NaN),
    600,
  );
  const longer = { ...policy, minimum_delay_seconds: 7200 };
  assert.equal(
    retryDelay(longer, 1, () => 1),
    8640,
  );
  assert.equal(
    retryDelay(longer, 1, () => 0),
    7200,
  );
});
test("collection rate errors preserve subcode, usage and retry policy without replaying long waits", async () => {
  let calls = 0;
  const meta = adsMeta(async () => {
    calls++;
    return Response.json(
      {
        error: { code: 17, error_subcode: 2446079, message: "private-message" },
      },
      { status: 400, headers },
    );
  });
  const response = await apiRoute(async () => {
    await meta.list("123", "private-token", "adsets", { limit: "1" });
    return Response.json({});
  })(new Request("https://service.test/read"));
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
  const body = await response.json();
  assert.equal(body.provider_code, 17);
  assert.equal(body.provider_subcode, 2446079);
  assert.equal(body.retry_after_seconds, 600);
  assert.equal(body.retry_source, "business_usage");
  assert.equal(body.retry_scope, "read");
  assert.equal(body.retry_policy.recovery_time_known, false);
  assert.equal(JSON.stringify(body).includes("private-"), false);
});
test("validation and actual write rate errors expose guidance while only safe short reads may retry", async () => {
  const action = actionInput.parse({
    action: "campaign.create",
    params: {
      name: "fixture",
      objective: "OUTCOME_TRAFFIC",
      special_ad_categories: [],
    },
  });
  for (const validation of [true, false]) {
    let calls = 0;
    const writer = writeMeta(async () => {
      calls++;
      return Response.json(
        { error: { code: 17, error_subcode: 2446079 } },
        { status: 400 },
      );
    });
    const response = await apiRoute(async () => {
      await writer.mutate("123", "token", action, validation);
      return Response.json({});
    })(new Request("https://service.test/action"));
    const body = await response.json();
    assert.equal(calls, 1);
    assert.equal(response.status, 429);
    assert.equal(body.retry_after_seconds, 300);
    assert.equal(body.retry_source, "default");
    assert.equal(body.retry_policy.recovery_time_known, false);
    assert.equal(body.retryable, validation);
    assert.equal(
      body.retry_scope,
      validation ? "validation" : "write_rejected",
    );
  }
});
