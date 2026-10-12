import { test } from "node:test";
import assert from "node:assert/strict";
import { rowReport, costRatio, reporting } from "../src/lib/ads/report";
import { adsMeta } from "../src/lib/ads/meta";
import { insightQuery } from "../src/lib/ads/queries";

test("ad-attributed follows, profile visits and exact action types keep independent counts and costs", () => {
  const out = rowReport({
    spend: "36.38",
    clicks: "93",
    instagram_profile_follow: "13",
    instagram_profile_visits: "65",
    inline_link_clicks: "27",
    actions: [
      { action_type: "link_click", value: "27" },
      { action_type: "post_reaction", value: "16" },
      { action_type: "onsite_conversion.post_save", value: "2" },
      { action_type: "onsite_conversion.post_net_save", value: "2" },
      { action_type: "onsite_conversion.messaging_subscribe", value: "3" },
    ],
    cost_per_action_type: [{ action_type: "link_click", value: "1.347407" }],
  });
  assert.equal(out.metrics.instagram_follows!.value, "13");
  assert.equal(out.metrics.clicks_all!.value, "93");
  assert.equal(out.metrics.link_clicks!.value, "27");
  assert.equal(out.metrics.saves!.value, "2");
  assert.equal(out.metrics.messaging_subscriptions!.value, "3");
  assert.equal(out.cost_per_result.instagram_follows!.value, "2.798462");
  assert.equal(
    out.cost_per_result.link_clicks!.source.field,
    "cost_per_action_type",
  );
  assert.equal(
    out.metrics.messaging_conversations_started!.status,
    "not_returned",
  );
  assert.equal(out.new_messaging_contacts.reason, "ui_mapping_not_verified");
});
test("zero, omitted, null, ambiguous actions and rejected fields remain distinguishable", () => {
  const out = rowReport({
    spend: "10.5",
    instagram_profile_follow: "0.00",
    instagram_profile_visits: null,
    actions: [
      { action_type: "link_click", value: "1" },
      { action_type: "link_click", value: "2" },
    ],
  });
  assert.equal(out.metrics.instagram_follows!.status, "available");
  assert.equal(out.metrics.instagram_follows!.value, "0.00");
  assert.equal(out.cost_per_result.instagram_follows!.value, null);
  assert.equal(
    out.cost_per_result.instagram_follows!.reason,
    "zero_denominator",
  );
  assert.equal(out.metrics.instagram_profile_visits!.reason, "provider_null");
  assert.equal(out.metrics.reach!.status, "not_returned");
  assert.equal(out.metrics.link_clicks!.reason, "ambiguous_action_rows");
  assert.equal(
    rowReport({}, ["instagram_profile_follow"]).metrics.instagram_follows!
      .status,
    "unsupported",
  );
  assert.equal(
    rowReport({ spend: 1e99 }).metrics.spend!.reason,
    "numeric_representation_unavailable",
  );
});
test("cost arithmetic handles exact large decimals, zero and rounding without floating-point loss", () => {
  assert.equal(
    costRatio("9007199254740993.01", "3"),
    "3002399751580331.003333",
  );
  assert.equal(costRatio("0", "3"), "0.000000");
  assert.equal(costRatio("1", "6"), "0.166667");
  for (const value of ["0", "0.00", "-1", "1e3"])
    assert.equal(costRatio("10", value), null);
});
test("account calendar, partial day, attribution and read-only entity filters stay explicit", () => {
  const q = insightQuery(
    new URLSearchParams(
      "from=2026-10-11&to=2026-10-13&daily=true&campaign_id=120254181403080057&action_report_time=conversion",
    ),
    "America/Sao_Paulo",
    Date.parse("2026-10-12T18:00:00Z"),
  );
  assert.deepEqual(JSON.parse(q.filtering!), [
    { field: "campaign.id", operator: "IN", value: ["120254181403080057"] },
  ]);
  const meta = reporting(q, "America/Sao_Paulo", "2026-10-12T18:00:00Z");
  assert.equal(meta.to_exclusive, "2026-10-13");
  assert.equal(meta.includes_partial_current_day, true);
  assert.equal(meta.action_report_time, "conversion");
  assert.equal(meta.reach_is_additive, false);
  for (const invalid of [
    "action_report_time=bad",
    "campaign_id=1&ad_id=2",
    "ad_id=not-an-id",
    "campaign_id=1&campaign_id=2",
  ])
    assert.throws(() => insightQuery(new URLSearchParams(invalid), "UTC"));
});
test("extended GET reports preserve raw attribution dimensions, unknown messaging actions and fixed pagination", async () => {
  const calls: URL[] = [];
  const client = adsMeta(async (url, options) => {
    assert.equal(options?.method, "GET");
    const u = new URL(String(url));
    calls.push(u);
    return Response.json({
      data: [
        {
          account_id: "123",
          date_start: "2026-10-11",
          date_stop: "2026-10-12",
          spend: "10.50",
          instagram_profile_follow: "3",
          instagram_profile_visits: "0",
          actions: [
            {
              action_type: "onsite_conversion.messaging_new_future_event",
              value: "7",
              "1d_ev": "2",
              action_destination: "instagram",
              access_token: "strip",
            },
          ],
        },
      ],
      paging: {
        next: "https://evil.invalid/?access_token=secret",
        cursors: { after: "opaque" },
      },
    });
  });
  const out = await client.insights("123", "token", { level: "ad" });
  assert.equal(out.next_cursor, "opaque");
  assert.ok(
    calls[0]!.searchParams.get("fields")!.includes("instagram_profile_follow"),
  );
  assert.deepEqual((out.data[0]!.actions as any[])[0], {
    action_type: "onsite_conversion.messaging_new_future_event",
    value: "7",
    "1d_ev": "2",
    action_destination: "instagram",
  });
  assert.equal(
    (out.data[0]!.report as ReturnType<typeof rowReport>).messaging_actions
      .length,
    1,
  );
  assert.equal(
    (out.data[0]!.report as ReturnType<typeof rowReport>).metrics
      .instagram_profile_visits!.value,
    "0",
  );
  assert.equal(calls.length, 1);
});
test("only a precise invalid Instagram field may fall back; auth, rate and generic errors fail explicitly", async () => {
  const fields: string[] = [];
  const client = adsMeta(async (url) => {
    const f = new URL(String(url)).searchParams.get("fields")!;
    fields.push(f);
    if (f.includes("instagram_profile_follow"))
      return Response.json(
        {
          error: {
            code: 100,
            message:
              "instagram_profile_follow is not valid for fields param. secret",
          },
        },
        { status: 400 },
      );
    return Response.json({ data: [] });
  });
  const out = await client.insights("123", "token", {});
  assert.deepEqual(out.unsupported_fields, ["instagram_profile_follow"]);
  assert.ok(out.requested_fields?.includes("instagram_profile_follow"));
  assert.ok(!out.provider_fields?.includes("instagram_profile_follow"));
  assert.equal(fields.length, 2);
  for (const [code, status, message] of [
    [100, 400, "bad breakdown"],
    [200, 403, "instagram_profile_follow is not valid for fields param"],
    [4, 429, "limit"],
  ] as const) {
    let count = 0;
    const broken = adsMeta(async () => {
      count++;
      return Response.json({ error: { code, message } }, { status });
    });
    await assert.rejects(() => broken.insights("123", "token", {}));
    assert.equal(count, 1);
  }
});
