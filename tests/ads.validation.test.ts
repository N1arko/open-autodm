import { test } from "node:test";
import assert from "node:assert/strict";
import { actionInput, paramsFor } from "../src/lib/ads/actions";
import { apiRoute } from "../src/lib/transport/api";
import { writeMeta } from "../src/lib/ads/writeMeta";
import { providerDetails } from "../src/lib/ads/diagnostics";

const action = actionInput.parse({
  action: "campaign.create",
  params: {
    name: "fixture",
    objective: "OUTCOME_TRAFFIC",
    special_ad_categories: [],
  },
});
const token = "fixture-access-token-at-least-20";
async function rejection(
  error: unknown,
  status = 400,
  headers?: HeadersInit,
  validation = true,
) {
  const writer = writeMeta(async () =>
    Response.json({ error }, { status, headers }),
  );
  return apiRoute(async () => {
    await writer.mutate("123", token, action, validation);
    return Response.json({ unexpected: true });
  })(new Request("https://service.test/validate"));
}

test("ordinary validation rejection retains numeric provider diagnostics without retry metadata", async () => {
  const response = await rejection({
    code: 100,
    error_subcode: 3858615,
    message: "Invalid parameter",
    error_user_title: "Invalid CTA",
    error_user_msg: "Choose a compatible CTA.",
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("retry-after"), null);
  const body = await response.json();
  assert.equal(body.provider_code, 100);
  assert.equal(body.provider_subcode, 3858615);
  assert.deepEqual(body.provider_details, {
    message: "Invalid parameter",
    user_title: "Invalid CTA",
    user_message: "Choose a compatible CTA.",
  });
  assert.equal("retryable" in body, false);
  const permission = await rejection({
    code: 200,
    error_subcode: 42,
    error_user_msg: "Permission required",
  });
  assert.equal(permission.status, 403);
  assert.equal((await permission.json()).provider_code, 200);
});

test("validation text removes credentials, URLs, HTML, control characters and bounds each field", async () => {
  const details = providerDetails(
    {
      message: `Invalid key. ${token} https://graph.facebook.com/x?access_token=private-url-secret <b>field</b>\nnext`,
      error_user_title: "\u202eTitle\u0000 " + "x".repeat(1500),
      error_user_msg:
        '{"access_token":"private-json-secret"} Bearer private-bearer-secret api_key=private-key-secret https://user:password@private.example/route',
      other_secret: "do-not-export",
    },
    token,
  )!;
  const text = JSON.stringify(details);
  for (const secret of [
    token,
    "private-url-secret",
    "private-json-secret",
    "private-bearer-secret",
    "private-key-secret",
    "private.example",
    "do-not-export",
  ])
    assert.equal(text.includes(secret), false, secret);
  assert(!/[\u0000-\u001f\u202a-\u202e]/.test(details.user_title!));
  assert(details.user_title!.length <= 1000);
  assert.match(details.message!, /field next/);
  assert.equal(providerDetails(null, token), undefined);
  assert.equal(
    providerDetails({ message: { access_token: token } }, token),
    undefined,
  );
  const response = await rejection({
    code: -1,
    error_subcode: "bad",
    message: token,
  });
  const body = await response.json();
  assert.equal("provider_code" in body, false);
  assert.equal("provider_subcode" in body, false);
  assert.equal(JSON.stringify(body).includes(token), false);
});

test("rate guidance survives with diagnostics; retry exposes only the final rejection and writes never replay", async () => {
  const rate = await rejection(
    { code: 4, error_subcode: 32, error_user_msg: "Wait" },
    429,
    { "Retry-After": "120" },
  );
  const body = await rate.json();
  assert.equal(rate.status, 429);
  assert.equal(rate.headers.get("retry-after"), "120");
  assert.equal(body.retryable, true);
  assert.equal(body.retry_scope, "validation");
  assert.equal(body.provider_code, 4);
  let calls = 0;
  const writer = writeMeta(async () =>
    ++calls === 1
      ? Response.json(
          { error: { code: 4, error_user_msg: "first" } },
          { status: 429, headers: { "Retry-After": "1" } },
        )
      : Response.json(
          { error: { code: 100, error_subcode: 77, error_user_msg: "final" } },
          { status: 400 },
        ),
  );
  const result = await apiRoute(async () => {
    await writer.mutate("123", token, action, true);
    return Response.json({});
  })(new Request("https://service.test/validate"));
  const final = await result.json();
  assert.equal(calls, 2);
  assert.equal(final.provider_code, 100);
  assert.equal(final.provider_subcode, 77);
  assert.equal(final.provider_details.user_message, "final");
  assert.equal("retry_after_seconds" in final, false);
  const write = await rejection(
    {
      code: 100,
      message: token,
      error_user_msg: "private provider write text",
    },
    400,
    undefined,
    false,
  );
  const rejected = await write.json();
  assert.equal(rejected.provider_code, 100);
  assert.equal("provider_details" in rejected, false);
});

test("profile actions use canonical promoted identity and explicit contextual CTA without provider context leakage", () => {
  const adset = {
    action: "adset.create",
    params: {
      name: "profile",
      campaign_id: "100",
      daily_budget: "3000",
      optimization_goal: "PROFILE_VISIT",
      billing_event: "IMPRESSIONS",
      destination_type: "INSTAGRAM_PROFILE",
      targeting: { geo_locations: { countries: ["BR"] } },
      promoted_object: { page_id: "700", instagram_actor_id: "900" },
    },
  };
  assert.deepEqual(
    paramsFor(actionInput.parse(adset)).promoted_object,
    adset.params.promoted_object,
  );
  assert.equal(
    actionInput.safeParse({
      ...adset,
      params: {
        ...adset.params,
        promoted_object: { instagram_user_id: "900" },
      },
    }).success,
    false,
  );
  const creative = {
    action: "creative.create",
    params: {
      name: "native profile",
      validation_adset_id: "200",
      creative: {
        kind: "image",
        page_id: "700",
        instagram_user_id: "900",
        image_hash: "ab".repeat(16),
        link: "https://www.instagram.com/fixture/",
        message: "unchanged ⟡",
        call_to_action: "VIEW_INSTAGRAM_PROFILE",
        contextual_multi_ads: { enroll_status: "OPT_OUT" },
      },
    },
  };
  const parsed = actionInput.parse(creative),
    params = paramsFor(parsed);
  assert.equal("validation_adset_id" in params, false);
  assert.equal(
    (params.object_story_spec as any).link_data.call_to_action.type,
    "VIEW_INSTAGRAM_PROFILE",
  );
  assert.equal(
    (params.object_story_spec as any).link_data.message,
    "unchanged ⟡",
  );
  assert.deepEqual(params.contextual_multi_ads, { enroll_status: "OPT_OUT" });
  assert.equal(
    actionInput.safeParse({
      ...creative,
      params: { ...creative.params, validation_adset_id: undefined },
    }).success,
    false,
  );
});
