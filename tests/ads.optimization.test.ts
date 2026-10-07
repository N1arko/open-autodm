import { test } from "node:test";
import assert from "node:assert/strict";
import { actionInput } from "../src/lib/ads/actions";
import {
  ruleInput,
  minor,
  evaluate,
  optimizationAction,
} from "../src/lib/ads/optimization";
const base = {
  name: "CPA guard",
  enabled: false,
  mode: "observe",
  level: "campaign",
  object_ids: ["100"],
  window_days: 3,
  min_spend_minor: "1000",
  min_impressions: 100,
  condition: {
    metric: "cpa_minor",
    operator: "gt",
    threshold: 500,
    action_type: "purchase",
  },
  action: { kind: "pause" },
};
test("optimization requires sufficient live evidence and distinguishes missing data, zero results and currencies", () => {
  const r = ruleInput.parse(base);
  assert.equal(minor("12.34", "BRL"), 1234);
  assert.equal(minor("12", "JPY"), 12);
  assert.equal(minor("12.345", "KWD"), 12345);
  assert.equal(minor("12.345", "BRL"), null);
  assert.equal(
    evaluate(
      r,
      {
        spend: "20.00",
        impressions: "200",
        actions: [{ action_type: "purchase", value: "2" }],
      },
      "BRL",
    ).matched,
    true,
  );
  assert.equal(
    evaluate(r, { spend: "20.00", impressions: "200" }, "BRL").metric,
    null,
  );
  assert.equal(evaluate(r, { spend: "20.00" }, "BRL").matched, false);
  assert.equal(
    evaluate(r, { spend: "0", impressions: "200" }, "BRL").matched,
    false,
  );
});
test("budget rules preserve direction, never activate paused ads and bound single-step growth", () => {
  const r = ruleInput.parse({
    ...base,
    action: {
      kind: "adjust_daily_budget",
      percent: 20,
      min_budget_minor: "500",
      max_budget_minor: "1100",
    },
  });
  assert.equal(
    (
      optimizationAction(r, {
        id: "100",
        status: "ACTIVE",
        daily_budget: "1000",
      })?.params as { daily_budget: string }
    ).daily_budget,
    "1100",
  );
  assert.equal(
    optimizationAction(r, {
      id: "100",
      status: "ACTIVE",
      daily_budget: "1200",
    }),
    null,
  );
  assert.equal(
    optimizationAction(r, {
      id: "100",
      status: "PAUSED",
      daily_budget: "1000",
    }),
    null,
  );
  assert.throws(() =>
    optimizationAction(r, {
      id: "100",
      status: "ACTIVE",
      daily_budget: "0",
      lifetime_budget: "10000",
    }),
  );
  assert.equal(
    ruleInput.safeParse({
      ...base,
      action: {
        kind: "adjust_daily_budget",
        percent: 100,
        min_budget_minor: "500",
        max_budget_minor: "1500",
      },
    }).success,
    false,
  );
  assert.equal(
    ruleInput.safeParse({ ...base, object_ids: ["100", "100"] }).success,
    false,
  );
});
test("resource actions reject raw credentials, empty changes and incomplete website/lookalike audiences", () => {
  assert.equal(
    actionInput.safeParse({
      action: "pixel.create",
      params: { name: "Pixel", access_token: "secret" },
    }).success,
    false,
  );
  assert.equal(
    actionInput.safeParse({
      action: "audience.create",
      params: { name: "Visitors", subtype: "WEBSITE" },
    }).success,
    false,
  );
  assert.equal(
    actionInput.safeParse({
      action: "audience.create",
      params: {
        name: "Lookalike",
        subtype: "LOOKALIKE",
        origin_audience_id: "500",
      },
    }).success,
    false,
  );
  assert.equal(
    actionInput.safeParse({
      action: "product.update",
      object_id: "100",
      params: { business_id: "444", catalog_id: "700" },
    }).success,
    false,
  );
  assert.equal(
    actionInput.safeParse({
      action: "product.create",
      params: {
        business_id: "444",
        catalog_id: "700",
        retailer_id: "sku",
        name: "Product",
        description: "Product",
        image_url: "http://127.0.0.1/private",
        url: "https://example.org",
        currency: "BRL",
        price: 1000,
        availability: "in stock",
        condition: "new",
        brand: "Brand",
      },
    }).success,
    false,
  );
});
