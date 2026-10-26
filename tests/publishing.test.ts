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
