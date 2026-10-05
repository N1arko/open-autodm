import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationSchema, validateVideoUrl } from "../src/lib/publishing/api";
import {
  publishingMeta,
  PublishingMetaError,
} from "../src/lib/publishing/meta";
import { buildOAuthUrl } from "../src/lib/instagram/oauth";

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
