import { test } from "node:test";
import assert from "node:assert/strict";
import { actionInput, paramsFor } from "../src/lib/ads/actions";
import {
  manualMessage,
  welcomeMessage,
  assetFeed,
  featureNames,
} from "../src/lib/ads/creative";
import { imageMetadata } from "../src/lib/ads/uploads";
import { providerJson } from "../src/lib/ads/readback";
import { retryAfter } from "../src/lib/ads/rateLimit";
import { writeMeta, WriteMetaError } from "../src/lib/ads/writeMeta";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP3sAAAAASUVORK5CYII=",
  "base64",
);
test("city-only geography never adds a radius or expansion; explicit coordinates, exclusion and units are bounded", () => {
  const input = {
    action: "adset.update",
    object_id: "200",
    params: {
      targeting: {
        geo_locations: {
          cities: [{ key: "253249" }],
          location_types: ["home"],
        },
        excluded_geo_locations: { regions: [{ key: "441" }] },
        targeting_automation: {
          advantage_audience: 0,
          individual_setting: { geo: 0 },
        },
      },
    },
  };
  const a = actionInput.parse(input),
    p = paramsFor(a);
  assert.deepEqual(p.targeting, input.params.targeting);
  for (const geo of [
    { cities: [{ key: "253249", radius: 50 }] },
    { cities: [{ key: "253249", radius: 0, distance_unit: "mile" }] },
    {
      custom_locations: [
        { latitude: 91, longitude: 0, radius: 5, distance_unit: "kilometer" },
      ],
    },
    { countries: [] },
  ])
    assert.equal(
      actionInput.safeParse({
        ...input,
        params: { targeting: { geo_locations: geo } },
      }).success,
      false,
    );
  assert.equal(
    actionInput.safeParse({
      ...input,
      params: {
        targeting: {
          geo_locations: {
            custom_locations: [
              {
                latitude: -27.6,
                longitude: -48.5,
                radius: 5,
                distance_unit: "kilometer",
              },
            ],
          },
        },
      },
    }).success,
    true,
  );
});
test("CBO plans explicitly choose a strategy while rejecting fictitious scalar campaign bid_amount", () => {
  const a = actionInput.parse({
    action: "campaign.create",
    params: {
      name: "Fixture",
      objective: "OUTCOME_ENGAGEMENT",
      special_ad_categories: [],
      daily_budget: "3000",
    },
  });
  assert.equal(paramsFor(a).bid_strategy, "LOWEST_COST_WITHOUT_CAP");
  assert.equal(paramsFor(a).status, "PAUSED");
  assert.equal(
    actionInput.safeParse({
      action: "campaign.update",
      object_id: "100",
      params: { bid_amount: "3000" },
    }).success,
    false,
  );
});
test("manual Direct welcome keeps responses optional and explicitly disables AI suggestions", () => {
  const message = manualMessage.parse({
    greeting: "oi ⟡",
    questions: [{ title: "valor?", response: null }],
  });
  const serialized = JSON.parse(welcomeMessage(message));
  assert.equal(serialized.ai_generated_icebreaker_toggle_enabled, false);
  assert.equal(serialized.text_format.message.ice_breakers[0].response, null);
  assert.equal(
    manualMessage.safeParse({ ...message, ai_generated_icebreakers: true })
      .success,
    false,
  );
  const a = actionInput.parse({
    action: "creative.create",
    params: {
      name: "Direct",
      creative: {
        kind: "instagram_direct",
        page_id: "700",
        instagram_user_id: "900",
        instagram_legacy_id: "901",
        adset_id: "200",
        media: { kind: "image", image_hash: "ab".repeat(16) },
        message: "hello",
        welcome: message,
        degrees_of_freedom_spec: {
          creative_features_spec: Object.fromEntries(
            featureNames.map((k) => [k, { enroll_status: "OPT_OUT" }]),
          ),
        },
        contextual_multi_ads: { enroll_status: "OPT_OUT" },
      },
    },
  });
  const p = paramsFor(a),
    spec = p.object_story_spec as any;
  assert.equal(
    spec.link_data.call_to_action.value.app_link,
    "instagram://direct?userid=901",
  );
  assert.equal(
    JSON.parse(p.page_welcome_message as string).text_format.message.text,
    "oi ⟡",
  );
  assert.equal("adset_id" in p, false);
});
test("placement assets reject dangling or duplicate labels and preserve explicit crop rectangles", () => {
  const base = {
    images: [
      {
        hash: "ab".repeat(16),
        adlabels: [{ name: "feed" }],
        image_crops: {
          "400x500": [
            [0, 0],
            [400, 500],
          ],
        },
      },
    ],
    bodies: [{ text: "fixture" }],
    call_to_action_types: ["LEARN_MORE"],
    ad_formats: ["SINGLE_IMAGE"],
    optimization_type: "PLACEMENT",
    asset_customization_rules: [
      {
        customization_spec: {
          publisher_platforms: ["instagram"],
          instagram_positions: ["stream"],
        },
        image_label: { name: "feed" },
      },
    ],
  };
  assert.equal(assetFeed.safeParse(base).success, true);
  assert.equal(
    assetFeed.safeParse({ ...base, images: [...base.images, ...base.images] })
      .success,
    false,
  );
  assert.equal(
    assetFeed.safeParse({
      ...base,
      asset_customization_rules: [
        {
          ...base.asset_customization_rules[0],
          image_label: { name: "foreign" },
        },
      ],
    }).success,
    false,
  );
});
test("image staging inspects actual file headers; arbitrary files, oversized dimensions and truncated data fail", () => {
  assert.deepEqual(
    { ...imageMetadata(image), sha256: null },
    {
      width: 1,
      height: 1,
      mime: "image/png",
      size: image.length,
      sha256: null,
    },
  );
  assert.throws(() => imageMetadata(Buffer.from("fake.png")), /invalid_image/);
  assert.throws(() => imageMetadata(image.subarray(0, -12)), /invalid_image/);
  const bad = Buffer.from(image);
  bad.writeUInt32BE(20000, 16);
  assert.throws(() => imageMetadata(bad), /invalid_image/);
});
test("provider readback strips nested credentials and URLs; retry estimates remain bounded and explainable", () => {
  const p = providerJson.parse({
    fields: {
      access_token: "secret",
      nested: {
        token: "secret",
        text: "https://x.test/?access_token=secret&x=1",
      },
    },
  }) as any;
  assert.equal(JSON.stringify(p).includes("secret"), false);
  assert.deepEqual(retryAfter(new Headers({ "Retry-After": "120" })), {
    seconds: 120,
    source: "retry_after",
  });
  assert.deepEqual(
    retryAfter(
      new Headers({
        "x-business-use-case-usage": JSON.stringify({
          account: [{ estimated_time_to_regain_access: 6 }],
        }),
      }),
    ),
    { seconds: 360, source: "business_usage" },
  );
});
test("a short rate limit retries read/validation once, definitive writes and uncertain writes never replay", async () => {
  const action = actionInput.parse({
    action: "campaign.create",
    params: {
      name: "Fixture",
      objective: "OUTCOME_TRAFFIC",
      special_ad_categories: [],
    },
  });
  for (const validation of [false, true]) {
    let calls = 0;
    const w = writeMeta(async () => {
      calls++;
      return calls === 1
        ? Response.json(
            { error: { code: 4 } },
            { status: 429, headers: { "Retry-After": "1" } },
          )
        : Response.json({ success: true, id: "100" });
    });
    if (validation) await w.mutate("123", "token", action, true);
    else
      await assert.rejects(
        () => w.mutate("123", "token", action),
        (e) =>
          e instanceof WriteMetaError &&
          !e.uncertain &&
          e.retryScope === "write_rejected",
      );
    assert.equal(calls, validation ? 2 : 1);
  }
  let calls = 0;
  const w = writeMeta(async () => {
    calls++;
    throw new Error("connection_lost");
  });
  await assert.rejects(
    () => w.mutate("123", "token", action),
    (e) => e instanceof WriteMetaError && e.uncertain,
  );
  assert.equal(calls, 1);
});
