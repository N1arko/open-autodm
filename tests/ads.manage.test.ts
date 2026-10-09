import { test } from "node:test";
import assert from "node:assert/strict";
import { actionInput, paramsFor, budgetWithin } from "../src/lib/ads/actions";
import { resolveMediaUrl } from "../src/lib/ads/manage";
import { writeMeta } from "../src/lib/ads/writeMeta";

test("advertising amounts remain exact integer minor units and reject ambiguous money/budget models", () => {
  const policy = {
    enabled: true,
    currency: "BRL",
    max_daily_budget_minor: "900719925474099",
    max_lifetime_budget_minor: null,
    revision: 1,
  };
  budgetWithin(900719925474099n, 0n, policy);
  assert.throws(
    () => budgetWithin(900719925474100n, 0n, policy),
    /daily_budget_limit/,
  );
  assert.throws(() => budgetWithin(0n, 1n, policy), /lifetime_budget_limit/);
  for (const value of ["10.50", 1050, "0", "-5", "1e3"])
    assert.equal(
      actionInput.safeParse({
        action: "campaign.update",
        object_id: "123",
        params: { daily_budget: value },
      }).success,
      false,
    );
  assert.equal(
    actionInput.safeParse({
      action: "campaign.update",
      object_id: "123",
      params: { daily_budget: "100", lifetime_budget: "100" },
    }).success,
    false,
  );
});
test("creation cannot activate implicitly; creative identity and unknown Meta payload fields are bounded", () => {
  const campaign = actionInput.parse({
    action: "campaign.create",
    params: {
      name: "Fixture",
      objective: "OUTCOME_TRAFFIC",
      special_ad_categories: [],
    },
  });
  assert.equal(paramsFor(campaign).status, "PAUSED");
  const bad = {
    action: "adset.create",
    params: {
      name: "Fixture",
      campaign_id: "123",
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: {
        geo_locations: { countries: ["BR"] },
        age_min: 40,
        age_max: 18,
      },
    },
  };
  assert.equal(actionInput.safeParse(bad).success, false);
  assert.equal(
    actionInput.safeParse({
      action: "ad.update",
      object_id: "1",
      params: { creative: { access_token: "secret" } },
    }).success,
    false,
  );
  const c = actionInput.parse({
    action: "creative.create",
    params: {
      name: "Image",
      creative: {
        kind: "image",
        page_id: "123",
        instagram_user_id: "456",
        image_url: "https://example.com/photo.jpg",
        link: "https://example.com",
        message: "Fixture",
      },
    },
  });
  const spec = paramsFor(c).object_story_spec as {
    instagram_user_id: string;
    link_data: { picture: string };
  };
  assert.equal(spec.instagram_user_id, "456");
  assert.equal(spec.link_data.picture, "https://example.com/photo.jpg");
});
test("media imports never use the bot internal-network allowlist", async () => {
  const old = process.env.BOT_WEBHOOK_ALLOWED_HOSTS;
  process.env.BOT_WEBHOOK_ALLOWED_HOSTS = "127.0.0.1,localhost";
  try {
    for (const value of [
      "https://127.0.0.1/video.mp4",
      "http://localhost/video.mp4",
      "https://user:pass@example.com/video.mp4",
      "https://[::1]/video.mp4",
    ])
      await assert.rejects(() => resolveMediaUrl(value), /invalid_media_url/);
  } finally {
    if (old === undefined) delete process.env.BOT_WEBHOOK_ALLOWED_HOSTS;
    else process.env.BOT_WEBHOOK_ALLOWED_HOSTS = old;
  }
});
test("an expired request deadline cannot send a late provider write", async () => {
  let calls = 0;
  const writer = writeMeta(
    async () => {
      calls++;
      return new Response('{"id":"123"}');
    },
    "https://graph.facebook.com/v26.0",
    Date.now() - 1,
  );
  const action = actionInput.parse({
    action: "campaign.create",
    params: {
      name: "Fixture",
      objective: "OUTCOME_TRAFFIC",
      special_ad_categories: [],
    },
  });
  await assert.rejects(
    () => writer.mutate("123", "fixture-token", action),
    (e: Error & { uncertain?: boolean }) =>
      e.message === "meta_unavailable" && e.uncertain === false,
  );
  assert.equal(calls, 0);
});
