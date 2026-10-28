import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, body, json } from "./fixture";
import { encrypt } from "../src/lib/crypto";
import { ApiError } from "../src/lib/transport/api";
import { engagementMeta } from "../src/lib/engagement/meta";
import { drainInstagram } from "../src/lib/engagement/worker";
import {
  prepareMaterial,
  completeMaterial,
  materialUrl,
} from "../src/lib/engagement/materials";
import {
  inboxConversations,
  inboxMessages,
  validateAction,
  enqueueAction,
  getOperation,
  cancelOperation,
  reconcileOperation,
  listComments,
  capabilities,
  events,
  publicationWorkflow,
  mediaDetails,
} from "../src/lib/engagement/api";
import {
  createPublication,
  editPublication,
  cancelPublication,
  getPublication,
} from "../src/lib/publishing/api";
import { drainPublications } from "../src/lib/publishing/worker";
import { publishingMeta } from "../src/lib/publishing/meta";
import { processWebhookPayload } from "../src/lib/automation/processWebhook";
import { normalizeWebhook } from "../src/lib/transport/inbox";
import type { EngagementPorts } from "../src/lib/engagement/service";
import type { TransportStore } from "../src/lib/transport/store";
let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  meta: Server,
  api: string,
  base: string,
  account: string;
const owner = randomUUID(),
  other = randomUUID(),
  encryptionKey = "ab".repeat(32);
let writes = 0,
  created = 0,
  comments = new Map<string, Record<string, unknown>>(),
  mode = "ok",
  hidden = false,
  enabled = true;
let forms: URLSearchParams[] = [];
let storageSize = 0,
  storageMime = "",
  signedPaths: string[] = [];
const req = (
  method: string,
  value?: unknown,
  token = "owner-token",
  key = "operation-1",
  query = "",
) =>
  new Request(api + "/api/v1/x" + query, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
const ports = (): EngagementPorts => ({
  meta: engagementMeta(fetch, base + "/v26.0"),
  encryptionKey,
  store: db.store,
});
const input = (
  action = "comment.create",
  extra: Record<string, unknown> = {},
) => ({
  action,
  media_id: "10001",
  ...(action === "comment.create" || action === "comment.reply"
    ? { text: "First comment" }
    : {}),
  ...extra,
});
async function queued(action = input(), key = "operation-1") {
  const r = await enqueueAction(
    account,
    ports,
  )(req("POST", action, "owner-token", key));
  assert.equal(r.status, 202, await r.clone().text());
  return (await r.json()).id as string;
}
const row = async (id: string) =>
  (await db.pool.query("SELECT * FROM instagram_operations WHERE id=$1", [id]))
    .rows[0];
const tick = async (p = ports()) => {
  await db.pool.query("UPDATE instagram_operations SET next_attempt_at=now()");
  return drainInstagram(p);
};
before(async () => {
  db = await databaseFixture();
  await db.pool.query("INSERT INTO auth.users(id) VALUES($1),($2)", [
    owner,
    other,
  ]);
  rest = restFixture(
    db.pool,
    db.store,
    { "Bearer owner-token": owner, "Bearer other-token": other },
    async (r, res, u) => {
      const path = u.pathname.replace("/storage/v1", "");
      if (path.startsWith("/object/upload/sign/")) {
        signedPaths.push(path);
        json(res, { url: path + "?token=fixture-upload" });
        return;
      }
      if (path.startsWith("/object/info/")) {
        json(res, {
          id: "fixture",
          version: "1",
          name: "file",
          bucket_id: "instagram-materials",
          created_at: new Date().toISOString(),
          size: storageSize,
          content_type: storageMime,
        });
        return;
      }
      if (path.startsWith("/object/sign/")) {
        json(res, { signedURL: path + "?token=fixture-download" });
        return;
      }
      json(res, { error: "not_found" }, 404);
    },
  );
  api = await listen(rest);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: api,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key-at-least-20",
    SUPABASE_SECRET_KEY: "fixture-secret-key-at-least-20-characters",
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    CRON_SECRET: "fixture-cron-secret-20",
  });
  meta = createServer(async (r, res) => {
    assert.equal(r.headers.authorization, "Bearer fake-meta-token");
    const u = new URL(r.url!, "http://meta"),
      path = u.pathname.replace("/v26.0/", "");
    if (r.method !== "GET") {
      writes++;
      const form = new URLSearchParams(await body(r));
      forms.push(form);
      if (path.endsWith("/media")) {
        created++;
        json(res, { id: "90001" });
        return;
      }
      if (path.endsWith("/media_publish")) {
        json(res, { id: "10001" });
        return;
      }
      if (mode === "429") {
        json(res, { error: { code: 4 } }, 429);
        return;
      }
      if (mode === "permission") {
        json(res, { error: { code: 10 } }, 403);
        return;
      }
      if (path.endsWith("/comments") || path.endsWith("/replies")) {
        const id = String(20000 + comments.size),
          c = {
            id,
            text: form.get("message"),
            media: { id: "10001" },
            from: { id: "17840001", username: "fixture" },
            timestamp: new Date().toISOString(),
            ...(path.endsWith("replies")
              ? { parent_id: path.split("/")[0] }
              : {}),
          };
        comments.set(id, c);
        if (mode === "disconnect") {
          r.socket.destroy();
          return;
        }
        if (mode === "500") {
          json(res, { error: { code: 2, is_transient: true } }, 500);
          return;
        }
        if (mode === "malformed") {
          json(res, { success: true });
          return;
        }
        json(res, { id });
        return;
      }
      if (r.method === "DELETE") comments.delete(path);
      else if (form.has("hide")) hidden = form.get("hide") === "true";
      else if (form.has("comment_enabled"))
        enabled = form.get("comment_enabled") === "true";
      json(res, { success: true });
      return;
    }
    if (path === "17840001/conversations") {
      json(res, {
        data: [{ id: "conv-1", updated_time: new Date().toISOString() }],
      });
      return;
    }
    if (path === "conv-1" || path === "conv-foreign") {
      if (u.searchParams.get("fields")?.startsWith("messages"))
        json(res, {
          id: path,
          messages: {
            data: [
              { id: "m-1", created_time: new Date().toISOString() },
              { id: "m-old", created_time: "2025-01-01T00:00:00Z" },
            ],
            paging: {
              next: "https://graph.invalid/page",
              cursors: { after: "cursor-next" },
            },
          },
        });
      else
        json(res, {
          id: path,
          participants: {
            data: [
              {
                id: path === "conv-1" ? "17840001" : "another-account",
                username: "fixture",
              },
              { id: "88", username: "guest" },
            ],
          },
        });
      return;
    }
    if (path === "m-1") {
      json(res, {
        id: path,
        created_time: new Date().toISOString(),
        message: "Fixture DM",
        from: { id: "88" },
        to: { data: [{ id: "17840001" }] },
      });
      return;
    }
    if (path === "17840001") {
      json(res, {
        id: "17840001",
        user_id: "17840001",
        username: "fixture",
        account_type: "BUSINESS",
      });
      return;
    }
    if (path === "me/permissions") {
      json(res, {
        data: [
          {
            permission: "instagram_business_manage_comments",
            status: "granted",
          },
          { permission: "instagram_business_basic", status: "granted" },
        ],
      });
      return;
    }
    if (path.endsWith("/subscribed_apps")) {
      json(res, { data: [{ id: "900", subscribed_fields: ["comments"] }] });
      return;
    }
    if (path === "90001") {
      json(res, { id: "90001", status_code: "FINISHED" });
      return;
    }
    if (path === "10001" || path === "10002") {
      if (u.searchParams.get("fields") === "id,is_comment_enabled")
        json(res, { id: path, is_comment_enabled: enabled });
      else
        json(res, {
          id: path,
          owner: { id: path === "10002" ? "someone-else" : "17840001" },
          media_type: "VIDEO",
          permalink: "https://www.instagram.com/reel/fixture/",
          timestamp: new Date().toISOString(),
          caption: "Fixture",
        });
      return;
    }
    if (path === "me") {
      json(res, { id: "scoped-owner", user_id: "17840001" });
      return;
    }
    if (path.endsWith("/comments") || path.endsWith("/replies")) {
      json(res, {
        data: [...comments.values()],
        ...(mode === "paging"
          ? {
              paging: {
                next: "https://untrusted.invalid/?access_token=secret",
                cursors: { after: "opaque-cursor" },
              },
            }
          : {}),
      });
      return;
    }
    if (comments.has(path)) {
      json(res, { ...comments.get(path), hidden });
      return;
    }
    json(res, { error: { code: 100 } }, 400);
  });
  base = await listen(meta);
});
after(async () => {
  for (const s of [rest, meta]) {
    s?.closeAllConnections();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
  await db?.close();
});
beforeEach(async () => {
  await db.pool.query(
    "TRUNCATE instagram_operations,instagram_publications,instagram_accounts CASCADE",
  );
  account = randomUUID();
  writes = created = 0;
  comments = new Map();
  mode = "ok";
  hidden = false;
  enabled = true;
  forms = [];
  storageSize = 0;
  storageMime = "";
  signedPaths = [];
  await db.pool.query(
    "INSERT INTO instagram_accounts(id,user_id,instagram_user_id,username,access_token_encrypted) VALUES($1,$2,'17840001','fixture',$3)",
    [account, owner, encrypt("fake-meta-token", encryptionKey)],
  );
});
test("comment create is durable, verified, idempotent and owner isolated", async () => {
  const id = await queued();
  await tick();
  const o = await row(id);
  assert.equal(o.status, "succeeded");
  assert.equal(o.receipt.verified, true);
  assert.equal(writes, 1);
  assert.equal(
    (await getOperation(id)(req("GET", undefined, "other-token"))).status,
    404,
  );
  assert.equal(
    (
      await enqueueAction(
        account,
        ports,
      )(req("POST", input(), "bot_" + "a".repeat(64)))
    ).status,
    401,
  );
  assert.equal(await queued(), id);
  assert.equal(await tick(), 0);
  assert.equal(writes, 1);
  assert.equal(
    (
      await enqueueAction(
        account,
        ports,
      )(req("POST", input("comment.create", { text: "Different" })))
    ).status,
    409,
  );
  assert.equal(
    "claim_token" in (await (await getOperation(id)(req("GET"))).json()),
    false,
  );
});
test("reply, hide, unhide, enable, disable and delete use explicit typed Graph actions", async () => {
  comments.set("333", {
    id: "333",
    text: "Hello",
    media: { id: "10001" },
    from: { id: "88", username: "guest" },
  });
  for (const [a, extra] of [
    ["comment.reply", { comment_id: "333" }],
    ["comment.hide", { comment_id: "333", hidden: true }],
    ["comment.hide", { comment_id: "333", hidden: false }],
    ["media.comments", { enabled: false }],
    ["media.comments", { enabled: true }],
    ["comment.delete", { comment_id: "333" }],
  ] as [string, Record<string, unknown>][]) {
    const id = await queued(input(a, extra), randomUUID());
    await tick();
    assert.equal((await row(id)).status, "succeeded");
    if (a !== "comment.delete")
      assert.equal((await row(id)).receipt.verified, true);
  }
  assert.equal(writes, 6);
  assert.equal(comments.has("333"), false);
});
test("foreign media and foreign comment cannot reach a write", async () => {
  let id = await queued(input("comment.create", { media_id: "10002" }));
  await tick();
  assert.equal((await row(id)).status, "failed");
  comments.set("333", { id: "333", media: { id: "10002" } });
  id = await queued(
    input("comment.hide", { comment_id: "333", hidden: true }),
    "foreign-comment",
  );
  await tick();
  assert.equal((await row(id)).status, "failed");
  assert.equal(writes, 0);
  assert.equal(
    (await mediaDetails(account, "10002", ports)(req("GET"))).status,
    404,
  );
});
test("comments paginate with opaque cursors, never provider next URLs", async () => {
  mode = "paging";
  const r = await listComments(account, "10001", undefined, ports)(req("GET"));
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.next_cursor, "opaque-cursor");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    (
      await listComments(
        account,
        "10001",
        undefined,
        ports,
      )(req("GET", undefined, "owner-token", "x", "?limit=51"))
    ).status,
    400,
  );
});
test("network loss, 5xx and malformed write acknowledgements stop in unknown and reconcile by owned comment ID", async () => {
  for (const m of ["disconnect", "500", "malformed"]) {
    mode = m;
    const id = await queued(input(), m);
    await tick();
    assert.equal((await row(id)).status, "unknown");
    const count = writes;
    assert.equal(await tick(), 0);
    assert.equal(writes, count);
    const external = [...comments.keys()].at(-1)!;
    mode = "ok";
    const r = await reconcileOperation(
      id,
      ports,
    )(req("POST", { external_id: external }));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await row(id)).status, "succeeded");
    assert.equal(writes, count);
  }
});
test("known rate rejection backs off, known permission rejection fails", async () => {
  mode = "429";
  const id = await queued();
  await tick();
  assert.equal((await row(id)).status, "queued");
  assert.equal(await drainInstagram(ports()), 0);
  mode = "ok";
  await tick();
  assert.equal((await row(id)).status, "succeeded");
  assert.equal(writes, 2);
  mode = "permission";
  const next = await queued(input(), "permission");
  await tick();
  assert.equal((await row(next)).status, "failed");
  assert.equal(await tick(), 0);
});
test("crash after remote acknowledgement cannot duplicate the comment", async () => {
  const id = await queued();
  const p = ports();
  const broken: TransportStore = {
    async rpc<T>(name: string, args: Record<string, unknown> = {}) {
      if (name === "instagram_finish" && args.p_state === "succeeded")
        throw Error("db lost");
      return db.store.rpc<T>(name, args);
    },
  };
  await tick({ ...p, store: broken });
  assert.equal((await row(id)).status, "executing");
  assert.equal(writes, 1);
  await db.pool.query(
    "UPDATE instagram_operations SET lease_expires_at=now()-interval '1 second'",
  );
  await tick();
  assert.equal((await row(id)).status, "unknown");
  assert.equal(writes, 1);
});
test("lost persisted receipt acknowledgement keeps success, failed verification preserves receipt", async () => {
  const id = await queued();
  const p = ports();
  const lost: TransportStore = {
    async rpc<T>(name: string, args: Record<string, unknown> = {}) {
      const r = await db.store.rpc<T>(name, args);
      if (name === "instagram_finish" && args.p_state === "succeeded")
        throw Error("ack lost");
      return r;
    },
  };
  await tick({ ...p, store: lost });
  assert.equal((await row(id)).status, "succeeded");
  assert.equal((await row(id)).receipt.verified, false);
  assert.equal(await tick(), 0);
  assert.equal(writes, 1);
  assert.equal(
    (await reconcileOperation(id, ports)(req("POST", {}))).status,
    200,
  );
  assert.equal((await row(id)).receipt.verified, true);
});
test("cancellation and lease fencing win before external mutation; parallel workers serialize account", async () => {
  const id = await queued();
  const [claim] = await db.store.rpc<Record<string, unknown>[]>(
    "instagram_claim",
    { p_limit: 4 },
  );
  assert.equal((await cancelOperation(id, ports)(req("DELETE"))).status, 200);
  assert.equal(
    await db.store.rpc("instagram_begin", {
      p_id: id,
      p_token: claim!.claim_token,
    }),
    false,
  );
  await queued(input(), "a");
  await queued(input(), "b");
  const claims = await Promise.all([
    db.store.rpc<unknown[]>("instagram_claim", { p_limit: 4 }),
    db.store.rpc<unknown[]>("instagram_claim", { p_limit: 4 }),
  ]);
  assert.equal(claims.flat().length, 1);
  assert.equal(writes, 0);
});
test("scheduled publication -> media -> first comment -> verified workflow runs once", async () => {
  const payload = {
    account_id: account,
    media_type: "IMAGE",
    image_url: "https://8.8.8.8/photo.jpg",
    caption: "Photo",
    alt_text: "A photo",
    is_ai_generated: true,
    first_comment: "First comment",
    publish_at: new Date(Date.now() + 86400000).toISOString(),
  };
  const response = await createPublication(req("POST", payload));
  assert.equal(response.status, 202, await response.clone().text());
  const pub = await response.json();
  assert.equal(await tick(), 0);
  assert.equal((await row(pub.first_comment_operation_id)).status, "queued");
  const edited = await editPublication(pub.id)(
    req("PATCH", { revision: 0, caption: "Updated photo" }),
  );
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).revision, 1);
  assert.equal(
    (
      await editPublication(pub.id)(
        req("PATCH", { revision: 0, caption: "stale" }),
      )
    ).status,
    409,
  );
  await db.pool.query(
    "UPDATE instagram_publications SET publish_at=now(),next_attempt_at=now()",
  );
  const pp = {
    encryptionKey,
    meta: publishingMeta(fetch, base + "/v26.0"),
    validateVideo: async () => {},
  };
  for (let i = 0; i < 3; i++) {
    await db.pool.query(
      "UPDATE instagram_publications SET next_attempt_at=now()",
    );
    await drainPublications(db.store, pp);
  }
  const published = await (await getPublication(pub.id)(req("GET"))).json();
  assert.equal(published.status, "published");
  assert.equal(published.media_id, "10001");
  assert.equal(forms[0]!.get("alt_text"), "A photo");
  assert.equal(forms[0]!.get("is_ai_generated"), "true");
  assert.equal(forms[0]!.get("caption"), "Updated photo");
  await tick();
  assert.equal(
    (await row(pub.first_comment_operation_id)).receipt.verified,
    true,
  );
  assert.equal(writes, 3);
  assert.equal(created, 1);
  assert.equal(
    (await (await publicationWorkflow(pub.id)(req("GET"))).json()).state,
    "completed",
  );
  assert.equal((await createPublication(req("POST", payload))).status, 202);
  assert.equal(await tick(), 0);
  assert.equal(writes, 3);
});
test("cancelled or unknown publication blocks its dependent comment without affecting historical jobs", async () => {
  const r = await createPublication(
    req("POST", {
      account_id: account,
      video_url: "https://8.8.8.8/a.mp4",
      first_comment: "After publication",
    }),
  );
  const p = await r.json();
  await cancelPublication(p.id)(req("DELETE"));
  await tick();
  assert.equal((await row(p.first_comment_operation_id)).status, "failed");
  assert.equal(
    (await row(p.first_comment_operation_id)).error_code,
    "publication_cancelled",
  );
  assert.equal(writes, 0);
});
test("capabilities report observed permissions and distinguish missing publishing grant", async () => {
  const r = await capabilities(account, ports)(req("GET"));
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.actions.comments, "granted");
  assert.equal(c.actions.publishing, "missing");
  assert.equal(c.graph_version, "v26.0");
});
test("signed webhook changes and direct-entry form normalize and journal once without bot integration", async () => {
  const value = {
    id: "555",
    from: { id: "88", username: "guest" },
    media: { id: "10001" },
    text: "Hello",
  };
  const payload = normalizeWebhook({
    object: "instagram",
    entry: [
      {
        id: "17840001",
        time: Math.floor(Date.now() / 1000),
        field: "comments",
        value,
      },
    ],
  });
  await processWebhookPayload(
    payload as Parameters<typeof processWebhookPayload>[0],
  );
  await processWebhookPayload(
    payload as Parameters<typeof processWebhookPayload>[0],
  );
  const r = await events(account)(req("GET"));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.data.length, 1);
  assert.equal(data.data[0].payload.text, "Hello");
  assert.equal(
    (await events(account)(req("GET", undefined, "other-token"))).status,
    404,
  );
});
test("new SQL functions and records are inaccessible to client roles", async () => {
  const client = await db.pool.connect();
  try {
    await client.query("SET ROLE authenticated");
    await assert.rejects(
      client.query("SELECT instagram_claim(4)"),
      /permission denied/,
    );
    await assert.rejects(
      client.query("UPDATE instagram_operations SET status='succeeded'"),
      /permission denied/,
    );
    assert.equal(
      (await client.query("SELECT * FROM instagram_operations")).rowCount,
      0,
    );
  } finally {
    await client.query("RESET ROLE");
    client.release();
  }
});

test("private material upload is owner scoped, idempotent, size checked and returns a bounded fetch URL", async () => {
  const payload = { mime: "image/jpeg", size: 12345 };
  let r = await prepareMaterial(account)(req("POST", payload));
  assert.equal(r.status, 201, await r.clone().text());
  const m = await r.json();
  assert.equal(m.upload_method, "PUT");
  assert.equal(m.status, "pending");
  r = await prepareMaterial(account)(req("POST", payload));
  assert.equal((await r.json()).id, m.id);
  assert.equal(signedPaths[0], signedPaths[1]);
  assert.equal(
    (await prepareMaterial(account)(req("POST", { ...payload, size: 123 })))
      .status,
    409,
  );
  assert.equal((await materialUrl(m.id)(req("GET"))).status, 409);
  assert.equal((await completeMaterial(m.id)(req("POST", {}))).status, 409);
  storageSize = 12345;
  storageMime = "image/jpeg";
  assert.equal((await completeMaterial(m.id)(req("POST", {}))).status, 200);
  assert.equal(
    (await completeMaterial(m.id)(req("POST", {}, "other-token"))).status,
    404,
  );
  r = await materialUrl(m.id)(req("GET"));
  assert.equal(r.status, 200);
  const download = await r.json();
  assert.match(download.url, /fixture-download/);
  assert.ok(Date.parse(download.expires_at) > Date.now());
  assert.equal("object_path" in download, false);
  assert.equal(
    (
      await materialUrl(m.id)(
        req("GET", undefined, "owner-token", "x", "?expires_in=99999999"),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await prepareMaterial(account)(
        req("POST", { mime: "image/png", size: 10 }, "owner-token", "png"),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await prepareMaterial(account)(
        req(
          "POST",
          { mime: "image/jpeg", size: 9 * 1024 * 1024 },
          "owner-token",
          "large",
        ),
      )
    ).status,
    400,
  );
  assert.equal(writes, 0);
});

test("live Direct reads check conversation membership and preserve unavailable historical message details", async () => {
  const list = await inboxConversations(account, ports)(req("GET"));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data[0].id, "conv-1");
  const r = await inboxMessages(account, "conv-1", ports)(req("GET"));
  assert.equal(r.status, 200, await r.clone().text());
  const data = await r.json();
  assert.equal(data.source, "meta_live");
  assert.equal(data.data[0].message, "Fixture DM");
  assert.equal(data.data[1].details_available, false);
  assert.equal(data.next_cursor, "cursor-next");
  assert.equal(
    (await inboxMessages(account, "conv-foreign", ports)(req("GET"))).status,
    404,
  );
  assert.equal(
    (
      await inboxMessages(
        account,
        "conv-1",
        ports,
      )(req("GET", undefined, "other-token"))
    ).status,
    404,
  );
  assert.equal(
    (
      await inboxMessages(
        account,
        "conv-1",
        ports,
      )(req("GET", undefined, "owner-token", "x", "?limit=50"))
    ).status,
    400,
  );
  assert.equal(writes, 0);
});
test("validate performs ownership and grant reads without sending a comment", async () => {
  const r = await validateAction(account, ports)(req("POST", input()));
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.ownership_verified, true);
  assert.equal(v.comments_permission, "granted");
  assert.equal(v.external_write_performed, false);
  assert.equal(writes, 0);
});

test("transient ownership reads back off before executing and preserve the safe queued state", async () => {
  const id = await queued();
  const p = ports();
  await tick({
    ...p,
    meta: {
      ...p.meta,
      media: async () => {
        throw new ApiError(502, "meta_unavailable");
      },
    },
  });
  assert.equal((await row(id)).status, "queued");
  assert.equal(writes, 0);
  await tick();
  assert.equal((await row(id)).status, "succeeded");
  assert.equal(writes, 1);
});
