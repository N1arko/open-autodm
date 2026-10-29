import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationSchema, validateVideoUrl } from "../src/lib/publishing/api";
import {
  publishingMeta,
  PublishingMetaError,
} from "../src/lib/publishing/meta";
import { buildOAuthUrl } from "../src/lib/instagram/oauth";
import { publicationHashInput } from "../src/lib/publishing/input";

test("new media types require exactly their own source fields and preserve legacy Reel hashes", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const video_url = "https://8.8.8.8/video.mp4";
  const item = { media_type: "VIDEO", url: video_url };
  const parse = (extra: object) => publicationSchema.safeParse({ account_id, ...extra });
  for (const extra of [
    {}, { media_type: "CAROUSEL", items: [item] },
    { media_type: "CAROUSEL", items: Array(21).fill(item) },
    { media_type: "CAROUSEL", video_url, items: [item, item] },
    { media_type: "STORIES", video_url, image_url: video_url },
    { media_type: "STORIES", video_url, caption: "not an overlay" },
    { media_type: "STORIES", video_url, cover_url: video_url },
    { media_type: "REELS", image_url: video_url },
  ]) assert.equal(parse(extra).success, false, JSON.stringify(extra));
  for (const extra of [
    { video_url }, { media_type: "REELS", video_url },
    { media_type: "STORIES", video_url }, { media_type: "STORIES", image_url: video_url },
    { media_type: "CAROUSEL", items: Array(20).fill(item) },
  ]) assert.equal(parse(extra).success, true);
  const old = { account_id, video_url, caption: "", share_to_feed: true, publish_at: null };
  assert.equal(publicationHashInput(publicationSchema.parse({ account_id, video_url }), null), JSON.stringify(old));
  assert.equal(publicationHashInput(publicationSchema.parse({ account_id, video_url, media_type: "REELS" }), null), JSON.stringify(old));
});

test("Graph serializes ordered carousel children and image/video Stories without Reel-only fields", async () => {
  const forms: URLSearchParams[] = [];
  const meta = publishingMeta(async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer private-token");
    forms.push(new URLSearchParams(init!.body as URLSearchParams));
    return Response.json({ id: String(100 + forms.length) });
  });
  await meta.createItem("1", { media_type: "VIDEO", url: "https://example.com/1.mp4" }, "private-token");
  await meta.createItem("1", { media_type: "IMAGE", url: "https://example.com/2.jpg" }, "private-token");
  await meta.createCarousel("1", ["101", "102"], "Caption", "private-token");
  await meta.createStory("1", { video_url: "https://example.com/story.mp4" }, "private-token");
  await meta.createStory("1", { image_url: "https://example.com/story.jpg" }, "private-token");
  assert.equal(forms[0]!.get("media_type"), "VIDEO");
  assert.equal(forms[0]!.get("is_carousel_item"), "true");
  assert.equal(forms[1]!.get("image_url"), "https://example.com/2.jpg");
  assert.equal(forms[1]!.has("video_url"), false);
  assert.equal(forms[2]!.get("children"), "101,102");
  assert.equal(forms[2]!.get("caption"), "Caption");
  for (const form of forms.slice(3)) {
    assert.equal(form.get("media_type"), "STORIES");
    assert.equal(form.has("caption"), false);
    assert.equal(form.has("share_to_feed"), false);
    assert.equal(form.has("cover_url"), false);
  }
});

test("media URLs never inherit internal bot endpoint exceptions", async () => {
  process.env.BOT_WEBHOOK_ALLOWED_HOSTS = "127.0.0.1";
  try {
    for (const url of [
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://10.0.0.1/x",
      "http://8.8.8.8/x",
      "https://user:password@example.com/x",
      "https://8.8.8.8/x#fragment",
      "https://8.8.8.8:8443/x",
    ])
      await assert.rejects(validateVideoUrl(url));
    await validateVideoUrl("https://8.8.8.8/video.mp4?signature=temporary");
  } finally {
    delete process.env.BOT_WEBHOOK_ALLOWED_HOSTS;
  }
});
test("publishing requires unambiguous timestamps and counts caption Unicode characters", () => {
  const input = {
    account_id: "11111111-1111-4111-8111-111111111111",
    video_url: "https://8.8.8.8/video.mp4",
  };
  assert.equal(
    publicationSchema.safeParse({ ...input, publish_at: "2026-12-01T18:00:00" })
      .success,
    false,
  );
  assert.equal(
    publicationSchema.safeParse({
      ...input,
      publish_at: "2026-12-01T18:00:00-03:00",
    }).success,
    true,
  );
  assert.equal(
    publicationSchema.safeParse({ ...input, caption: "👋".repeat(2200) })
      .success,
    true,
  );
  assert.equal(
    publicationSchema.safeParse({ ...input, caption: "👋".repeat(2201) })
      .success,
    false,
  );
  assert.equal(
    publicationSchema.safeParse({ ...input, unexpected: "value" }).success,
    false,
  );
  const url = new URL(
    buildOAuthUrl("123", "https://autodm.example/callback", "state", true),
  );
  assert.ok(
    url.searchParams
      .get("scope")!
      .split(",")
      .includes("instagram_business_content_publish"),
  );
  assert.equal(
    new URL(
      buildOAuthUrl("123", "https://autodm.example/callback", "state"),
    ).searchParams
      .get("scope")!
      .split(",")
      .includes("instagram_business_content_publish"),
    false,
  );
});
test("publish acknowledgement must be a media ID; malformed results and provider 5xx are uncertain", async () => {
  for (const response of [
    new Response("bad", { status: 200 }),
    Response.json({ ok: true }),
    Response.json({ error: { code: 2 } }, { status: 500 }),
  ]) {
    const meta = publishingMeta(async () => response);
    await assert.rejects(
      meta.publish("123", "456", "secret"),
      (error) => error instanceof PublishingMetaError && error.uncertain,
    );
  }
  const rejected = publishingMeta(async () =>
    Response.json({ error: { code: 4 } }, { status: 429 }),
  );
  await assert.rejects(
    rejected.publish("123", "456", "secret"),
    (error) =>
      error instanceof PublishingMetaError &&
      error.retryable &&
      !error.uncertain,
  );
});

test("Trial Reels require an explicit strategy, only apply to Reels and preserve ordinary hashes", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const video_url = "https://8.8.8.8/video.mp4";
  const ordinary = publicationSchema.parse({ account_id, video_url });
  const ordinaryHash = publicationHashInput(ordinary, null);
  const hashes = new Set([ordinaryHash]);
  for (const graduation_strategy of ["MANUAL", "SS_PERFORMANCE"]) {
    const input = publicationSchema.parse({ account_id, video_url, trial_params: { graduation_strategy } });
    assert.deepEqual(input.trial_params, { graduation_strategy });
    hashes.add(publicationHashInput(input, null));
  }
  assert.equal(hashes.size, 3);
  for (const trial_params of [null, {}, true, "MANUAL", { graduation_strategy: "AUTO" }, { graduation_strategy: "MANUAL", extra: true }]) {
    assert.equal(publicationSchema.safeParse({ account_id, video_url, trial_params }).success, false);
  }
  for (const media of [
    { media_type: "IMAGE", image_url: "https://8.8.8.8/photo.jpg" },
    { media_type: "STORIES", video_url },
    { media_type: "CAROUSEL", items: Array(2).fill({ media_type: "VIDEO", url: video_url }) },
  ]) assert.equal(publicationSchema.safeParse({ account_id, ...media, trial_params: { graduation_strategy: "MANUAL" } }).success, false);
  assert.equal(publicationHashInput(publicationSchema.parse({ account_id, video_url, media_type: "REELS" }), null), ordinaryHash);
});

test("Graph encodes Trial Reels as JSON and omits the option for ordinary publishing", async () => {
  const forms: URLSearchParams[] = [];
  const meta = publishingMeta(async (_url, init) => {
    forms.push(new URLSearchParams(init!.body as URLSearchParams));
    return Response.json({ id: "99001" });
  });
  for (const graduation_strategy of ["MANUAL", "SS_PERFORMANCE"] as const) {
    await meta.create("123", "https://example.com/video.mp4", "Caption", true, "secret", undefined, { trial_params: { graduation_strategy } });
  }
  await meta.create("123", "https://example.com/video.mp4", "Caption", true, "secret");
  assert.deepEqual(JSON.parse(forms[0]!.get("trial_params")!), { graduation_strategy: "MANUAL" });
  assert.deepEqual(JSON.parse(forms[1]!.get("trial_params")!), { graduation_strategy: "SS_PERFORMANCE" });
  assert.equal(forms[2]!.has("trial_params"), false);
});


test("publishing retains bounded provider diagnostics and redacts credentials and URLs", async () => {
  const token = "private-meta-credential";
  const meta = publishingMeta(async () => Response.json({ error: {
    code: 10, error_subcode: 2207079, message: `Trial unavailable ${token} https://example.com/private?access_token=hidden`,
    error_user_title: "<b>Account unavailable</b>", error_user_msg: "authorization=hidden\n" + "x".repeat(2000),
    unrelated: "must not escape", access_token: token,
  } }, { status: 400 }));
  await assert.rejects(meta.create("123", "https://example.com/video.mp4", "", true, token, undefined,
    { trial_params: { graduation_strategy: "MANUAL" } }), (error) => {
      assert.ok(error instanceof PublishingMetaError);
      assert.equal(error.code, "meta_http_400_code_10");
      assert.equal(error.retryable, false);
      assert.equal(error.uncertain, false);
      assert.deepEqual(Object.keys(error.providerError!).sort(), ["code", "details", "http_status", "subcode"]);
      assert.equal(error.providerError!.subcode, 2207079);
      const text = JSON.stringify(error.providerError);
      for (const secret of [token, "https://", "hidden", "must not escape", "<b>"]) assert.ok(!text.includes(secret));
      assert.ok(error.providerError!.details!.user_message!.length <= 1000);
      return true;
    });
});
