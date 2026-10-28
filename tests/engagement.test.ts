import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSchema } from "../src/lib/engagement/input";
import { engagementMeta, EngagementError } from "../src/lib/engagement/meta";
import { publicationSchema } from "../src/lib/publishing/input";
import { normalizeWebhook, webhookSchema } from "../src/lib/transport/inbox";
test("only explicit typed engagement actions can reach Graph", () => {
  for (const input of [
    { action: "graph.proxy", path: "me" },
    {
      action: "comment.delete",
      media_id: "1",
      comment_id: "2",
      token: "secret",
    },
    { action: "comment.create", media_id: "1/evil", text: "hello" },
    { action: "comment.reply", media_id: "1", text: "hello" },
    { action: "comment.hide", media_id: "1", comment_id: "2", hidden: "false" },
  ])
    assert.equal(actionSchema.safeParse(input).success, false);
});
test("image options, alt text, frame cover and first comment are scoped to compatible media", () => {
  const base = { account_id: "00000000-0000-4000-8000-000000000001" };
  for (const input of [
    {
      media_type: "IMAGE",
      image_url: "https://cdn.example/a.jpg",
      alt_text: "Photo",
      first_comment: "Hello",
      is_ai_generated: true,
    },
    { video_url: "https://cdn.example/a.mp4", thumb_offset: 3500 },
  ])
    assert.equal(
      publicationSchema.safeParse({ ...base, ...input }).success,
      true,
    );
  for (const input of [
    {
      media_type: "STORIES",
      image_url: "https://cdn.example/a.jpg",
      first_comment: "Hello",
    },
    { video_url: "https://cdn.example/a.mp4", alt_text: "invalid" },
    {
      media_type: "IMAGE",
      image_url: "https://cdn.example/a.jpg",
      thumb_offset: 3,
    },
    {
      media_type: "CAROUSEL",
      items: [
        {
          media_type: "VIDEO",
          url: "https://cdn.example/a.mp4",
          alt_text: "invalid",
        },
        { media_type: "IMAGE", url: "https://cdn.example/b.jpg" },
      ],
    },
  ])
    assert.equal(
      publicationSchema.safeParse({ ...base, ...input }).success,
      false,
    );
});
test("transport normalizes both documented comment webhook shapes without dropping mentions", () => {
  const body = normalizeWebhook({
    object: "instagram",
    entry: [
      {
        id: "1",
        time: 123,
        field: "comments",
        value: { comment_id: "2", text: "Hello" },
      },
      {
        id: "1",
        time: 123,
        changes: [{ field: "mentions", value: { media_id: "3" } }],
      },
    ],
  });
  const parsed = webhookSchema.parse(body);
  assert.equal((parsed.entry[0]!.changes![0]!.value as { id: string }).id, "2");
  assert.equal(parsed.entry[1]!.changes![0]!.field, "mentions");
});
test("ambiguous writes stay uncertain; known Graph permission rejections are definitive", async () => {
  for (const fixture of [
    { status: 500, body: { error: { code: 2 } } },
    { status: 200, body: {} },
    { status: 302, body: {} },
  ]) {
    const meta = engagementMeta(async () =>
      Response.json(fixture.body, { status: fixture.status }),
    );
    await assert.rejects(
      meta.execute(
        { action: "comment.create", media_id: "1", text: "Hello" },
        "secret",
      ),
      (e) => e instanceof EngagementError && e.uncertain,
    );
  }
  const meta = engagementMeta(async () =>
    Response.json({ error: { code: 10 } }, { status: 403 }),
  );
  await assert.rejects(
    meta.execute(
      { action: "comment.create", media_id: "1", text: "Hello" },
      "secret",
    ),
    (e) =>
      e instanceof EngagementError &&
      !e.uncertain &&
      !e.retryable &&
      e.status === 403,
  );
});
