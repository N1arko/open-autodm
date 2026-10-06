import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, body, json } from "./fixture";
import { encrypt } from "../src/lib/crypto";
import { hash } from "../src/lib/transport/api";
import {
  createPublication,
  listPublications,
  getPublication,
  cancelPublication,
} from "../src/lib/publishing/api";
import {
  drainPublications,
  type PublishingPorts,
} from "../src/lib/publishing/worker";
import {
  publishingMeta,
  PublishingMetaError,
} from "../src/lib/publishing/meta";
import type { TransportStore } from "../src/lib/transport/store";

let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  metaServer: Server,
  api: string,
  metaBase: string;
const owner = randomUUID(),
  other = randomUUID(),
  key = "ab".repeat(32),
  video = "https://8.8.8.8/video.mp4";
let account: string,
  created = 0,
  published = 0,
  polls = 0,
  linkReads = 0,
  mode = "ok";
let receivedCover: string | null = null;
const req = (
  method: string,
  value?: unknown,
  bearer = "owner-token",
  idem = "video-1",
) =>
  new Request(`${api}/api/v1/publications`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idem,
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
const input = (extra: Record<string, unknown> = {}) => ({
  account_id: account,
  video_url: video,
  caption: "Hello 👋",
  ...extra,
});
const ports = (): PublishingPorts => ({
  encryptionKey: key,
  meta: publishingMeta(fetch, `${metaBase}/v26.0`),
  validateVideo: async () => {},
});
const forceDue = () =>
  db.pool.query("UPDATE instagram_publications SET next_attempt_at=now()");
const row = async (id: string) =>
  (
    await db.pool.query("SELECT * FROM instagram_publications WHERE id=$1", [
      id,
    ])
  ).rows[0];
async function queued(extra: Record<string, unknown> = {}, idem = "video-1") {
  const response = await createPublication(
    req("POST", input(extra), "owner-token", idem),
  );
  assert.equal(response.status, 202);
  return (await response.json()).id as string;
}
async function tick(
  store: TransportStore = db.store,
  overrides: Partial<PublishingPorts> = {},
) {
  await forceDue();
  return drainPublications(store, { ...ports(), ...overrides });
}
before(async () => {
  db = await databaseFixture();
  await db.pool.query("INSERT INTO auth.users(id) VALUES($1),($2)", [
    owner,
    other,
  ]);
  rest = restFixture(db.pool, db.store, {
    "Bearer owner-token": owner,
    "Bearer other-token": other,
  });
  api = await listen(rest);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: api,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key-at-least-20",
    SUPABASE_SECRET_KEY: "fixture-secret-key-at-least-20-characters",
    TOKEN_ENCRYPTION_KEY: key,
    CRON_SECRET: "fixture-cron-secret-20",
  });
  metaServer = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer fake-meta-token");
    const path = new URL(request.url!, metaBase).pathname;
    if (request.method === "POST" && path.endsWith("/media")) {
      const form = new URLSearchParams(await body(request));
      assert.equal(form.get("media_type"), "REELS");
      assert.equal(form.get("video_url"), video);
      assert.equal(form.get("caption"), "Hello 👋");
      assert.equal(form.get("share_to_feed"), "true");
      receivedCover = form.get("cover_url");
      created++;
      json(response, { id: "99001" });
    } else if (request.method === "POST" && path.endsWith("/media_publish")) {
      const form = new URLSearchParams(await body(request));
      assert.equal(form.get("creation_id"), "99001");
      published++;
      if (mode === "disconnect") {
        request.socket.destroy();
        return;
      }
      if (mode === "500") {
        json(response, { error: { code: 2, is_transient: true } }, 500);
        return;
      }
      if (mode === "429") {
        json(response, { error: { code: 4 } }, 429);
        return;
      }
      json(response, { id: "123456" });
    } else if (path.endsWith("/99001")) {
      polls++;
      json(response, { status_code: polls === 1 ? "IN_PROGRESS" : "FINISHED" });
    } else if (path.endsWith("/123456")) {
      linkReads++;
      json(response, { permalink: "https://www.instagram.com/reel/fixture/" });
    } else json(response, { error: { code: 100 } }, 400);
  });
  metaBase = await listen(metaServer);
});
after(async () => {
  for (const server of [rest, metaServer]) {
    server?.closeAllConnections();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
  await db?.close();
});
beforeEach(async () => {
  await db.pool.query(
    "TRUNCATE instagram_publications,instagram_accounts CASCADE",
  );
  account = randomUUID();
  created = published = polls = linkReads = 0;
  mode = "ok";
  receivedCover = null;
  await db.pool.query(
    "INSERT INTO instagram_accounts(id,user_id,instagram_user_id,username,access_token_encrypted) VALUES($1,$2,$3,$4,$5)",
    [account, owner, "17840001", "fixture", encrypt("fake-meta-token", key)],
  );
});

test("real owner API and Graph HTTP publish scheduled Reel once and return permalink", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const id = await queued({ publish_at: future });
  assert.equal(await drainPublications(db.store, ports()), 0);
  await db.pool.query(
    "UPDATE instagram_publications SET publish_at=now(),next_attempt_at=now() WHERE id=$1",
    [id],
  );
  await tick();
  assert.equal((await row(id)).status, "processing");
  assert.equal(published, 0);
  await tick();
  assert.equal(published, 0);
  await tick();
  assert.equal((await row(id)).status, "published");
  await tick();
  assert.equal(
    (await row(id)).permalink,
    "https://www.instagram.com/reel/fixture/",
  );
  await tick();
  assert.equal(created, 1);
  assert.equal(published, 1);
  assert.equal(linkReads, 1);
  const replay = await createPublication(
    req("POST", input({ publish_at: future })),
  );
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, id);
  assert.equal(
    (
      await createPublication(
        req("POST", input({ caption: "Different", publish_at: future })),
      )
    ).status,
    409,
  );
  const response = await getPublication(id)(req("GET"));
  const visible = await response.json();
  assert.equal(visible.media_id, "123456");
  assert.equal(visible.status, "published");
  assert.equal("claim_token" in visible, false);
  assert.equal("request_hash" in visible, false);
});
test("cover survives the queue, reaches Meta and participates in idempotency", async () => {
  const cover_url = "https://8.8.8.8/cover.jpg";
  const id = await queued({ cover_url });
  assert.equal((await row(id)).cover_url, cover_url);
  await tick();
  assert.equal(receivedCover, cover_url);
  await tick();
  await tick();
  await tick();
  const visible = await (await getPublication(id)(req("GET"))).json();
  assert.equal(visible.cover_url, cover_url);
  assert.equal(visible.status, "published");
  assert.equal(published, 1);
  assert.equal(
    (await createPublication(req("POST", input({ cover_url })))).status,
    202,
  );
  assert.equal(
    (
      await createPublication(
        req("POST", input({ cover_url: "https://8.8.8.8/other.jpg" })),
      )
    ).status,
    409,
  );
});
test("cover URL validation fails closed at enqueue and again before Meta fetches it", async () => {
  for (const cover_url of [
    "https://127.0.0.1/cover.jpg",
    "http://8.8.8.8/cover.jpg",
    "https://user:secret@8.8.8.8/cover.jpg",
  ]) {
    const response = await createPublication(req("POST", input({ cover_url })));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_cover_url");
  }
  const cover_url = "https://8.8.8.8/cover.jpg";
  const id = await queued({ cover_url });
  await tick(db.store, {
    validateVideo: async (url) => {
      if (url === cover_url) throw new Error("DNS changed");
    },
  });
  assert.equal((await row(id)).status, "failed");
  assert.equal((await row(id)).error_code, "invalid_cover_url");
  assert.equal(created, 0);
  assert.equal(published, 0);
});
test("cover migration accepts the prior eight-argument enqueue RPC", async () => {
  const result = await db.pool.query(
    "SELECT publishing_enqueue($1,$2,$3,$4,$5,$6,$7,$8) AS job",
    [owner, account, video, "Hello 👋", true, null, "legacy", "legacy-hash"],
  );
  assert.equal(result.rows[0].job.cover_url, null);
});
test("owner isolation, bot credentials, input validation, cancellation and expired tokens", async () => {
  const id = await queued();
  assert.equal(
    (await getPublication(id)(req("GET", undefined, "other-token"))).status,
    404,
  );
  assert.equal(
    (await cancelPublication(id)(req("DELETE", undefined, "other-token")))
      .status,
    404,
  );
  assert.equal(
    (await createPublication(req("POST", input(), "other-token"))).status,
    404,
  );
  assert.equal(
    (await listPublications(req("GET", undefined, `bot_${"a".repeat(64)}`)))
      .status,
    401,
  );
  assert.equal(
    (await createPublication(req("POST", input(), undefined, ""))).status,
    400,
  );
  assert.equal(
    (
      await createPublication(
        req(
          "POST",
          input({ video_url: "https://127.0.0.1/movie.mp4" }),
          undefined,
          "unsafe",
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await createPublication(
        req(
          "POST",
          input({ publish_at: "2026-12-01T18:00:00" }),
          undefined,
          "localtime",
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await createPublication(
        req(
          "POST",
          input({
            publish_at: new Date(Date.now() + 367 * 86400_000).toISOString(),
          }),
          undefined,
          "far",
        ),
      )
    ).status,
    400,
  );
  assert.equal((await cancelPublication(id)(req("DELETE"))).status, 200);
  assert.equal((await cancelPublication(id)(req("DELETE"))).status, 200);
  assert.equal(await tick(), 0);
  assert.equal(published, 0);
  await db.pool.query(
    "UPDATE instagram_accounts SET token_expires_at=now()-interval '1 minute' WHERE id=$1",
    [account],
  );
  assert.equal(
    (await createPublication(req("POST", input(), undefined, "expired")))
      .status,
    409,
  );
});
test("headless owner token can publish while anonymous and direct SQL mutations are blocked", async () => {
  const token = `adm_${"c".repeat(64)}`;
  process.env.OWNER_API_TOKEN_HASH = hash(token);
  process.env.OWNER_API_USER_ID = owner;
  try {
    assert.equal(
      (await createPublication(req("POST", input(), token))).status,
      202,
    );
  } finally {
    delete process.env.OWNER_API_TOKEN_HASH;
    delete process.env.OWNER_API_USER_ID;
  }
  const client = await db.pool.connect();
  try {
    await client.query("SET ROLE authenticated");
    await assert.rejects(
      client.query("SELECT public.publishing_claim(4)"),
      /permission denied/,
    );
    await assert.rejects(
      client.query(
        "UPDATE public.instagram_publications SET status='published'",
      ),
      /permission denied/,
    );
    assert.equal(
      (await client.query("SELECT * FROM public.instagram_publications"))
        .rowCount,
      0,
    );
  } finally {
    await client.query("RESET ROLE");
    client.release();
  }
});
test("connection loss and HTTP 500 after publish are uncertain and never automatically repeated", async () => {
  for (const failure of ["disconnect", "500"]) {
    await db.pool.query("TRUNCATE instagram_publications");
    created = published = polls = 0;
    mode = failure;
    const id = await queued();
    await tick();
    await tick();
    await tick();
    assert.equal((await row(id)).status, "publication_unknown");
    assert.equal(published, 1);
    mode = "ok";
    assert.equal(await tick(), 0);
    assert.equal(published, 1);
    assert.equal((await cancelPublication(id)(req("DELETE"))).status, 409);
  }
});
test("known rate-limit rejection backs off and can publish the same container later", async () => {
  mode = "429";
  const id = await queued();
  await tick();
  await tick();
  await tick();
  assert.equal((await row(id)).status, "processing");
  assert.equal(published, 1);
  assert.equal(await drainPublications(db.store, ports()), 0);
  mode = "ok";
  await tick();
  await tick();
  assert.equal((await row(id)).status, "published");
  assert.equal(created, 1);
  assert.equal(published, 2);
});
test("worker crash after successful remote publish keeps a marker that prevents reposting", async () => {
  const id = await queued();
  await tick();
  await tick();
  const broken: TransportStore = {
    async rpc<T>(name: string, args: Record<string, unknown> = {}) {
      if (name === "publishing_finish" && args?.p_state === "published")
        throw new Error("db response lost");
      return db.store.rpc<T>(name, args);
    },
  };
  await tick(broken);
  assert.equal((await row(id)).status, "publishing");
  assert.equal(published, 1);
  await db.pool.query(
    "UPDATE instagram_publications SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await tick();
  assert.equal((await row(id)).status, "publication_unknown");
  assert.equal(published, 1);
});
test("lost acknowledgement of persisted success only retries permalink lookup", async () => {
  const id = await queued();
  await tick();
  await tick();
  const lost: TransportStore = {
    async rpc<T>(name: string, args: Record<string, unknown> = {}) {
      const result = await db.store.rpc<T>(name, args);
      if (name === "publishing_finish" && args?.p_state === "published")
        throw new Error("acknowledgement lost");
      return result;
    },
  };
  await tick(lost);
  assert.equal((await row(id)).status, "published");
  await tick();
  assert.equal(published, 1);
  assert.equal(
    (await row(id)).permalink,
    "https://www.instagram.com/reel/fixture/",
  );
});
test("cancellation wins the race before publication and stale lease cannot authorize a publish", async () => {
  const id = await queued();
  await tick();
  const meta = ports().meta;
  await tick(db.store, {
    meta: {
      ...meta,
      status: async () => {
        assert.equal((await cancelPublication(id)(req("DELETE"))).status, 200);
        return "FINISHED";
      },
    },
  });
  assert.equal((await row(id)).status, "cancelled");
  assert.equal(published, 0);
  const next = await queued({}, "second");
  const [first] = await db.store.rpc<Record<string, unknown>[]>(
    "publishing_claim",
    { p_limit: 4 },
  );
  await db.store.rpc("publishing_context", {
    p_id: next,
    p_token: first!.claim_token,
  });
  await db.pool.query(
    "UPDATE instagram_publications SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [next],
  );
  const [fresh] = await db.store.rpc<Record<string, unknown>[]>(
    "publishing_claim",
    { p_limit: 4 },
  );
  assert.notEqual(first!.claim_token, fresh!.claim_token);
  assert.equal(
    await db.store.rpc("publishing_begin_publish", {
      p_id: next,
      p_token: first!.claim_token,
    }),
    false,
  );
  assert.equal(
    await db.store.rpc("publishing_finish", {
      p_id: next,
      p_token: first!.claim_token,
      p_state: "failed",
    }),
    false,
  );
});
test("parallel workers serialize each account while other accounts make progress", async () => {
  await queued({}, "a1");
  await queued({}, "a2");
  await queued({}, "a3");
  const another = randomUUID();
  await db.pool.query(
    "INSERT INTO instagram_accounts(id,user_id,instagram_user_id,username,access_token_encrypted) VALUES($1,$2,$3,$4,$5)",
    [another, owner, "17840002", "fixture2", encrypt("fake-meta-token", key)],
  );
  await queued({ account_id: another }, "b1");
  const claims = await Promise.all([
    db.store.rpc<Record<string, unknown>[]>("publishing_claim", { p_limit: 4 }),
    db.store.rpc<Record<string, unknown>[]>("publishing_claim", { p_limit: 4 }),
  ]);
  const jobs = claims.flat();
  assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map((x) => x.account_id)).size, 2);
});
test("expired containers, account circuit breaker and missing publishing permission remain explicit", async () => {
  const id = await queued();
  await tick();
  await db.pool.query(
    "UPDATE instagram_accounts SET paused_until=now()+interval '1 hour' WHERE id=$1",
    [account],
  );
  await tick();
  assert.equal(published, 0);
  assert.equal(await drainPublications(db.store, ports()), 0);
  await db.pool.query(
    "UPDATE instagram_accounts SET paused_until=NULL WHERE id=$1",
    [account],
  );
  const meta = ports().meta;
  await tick(db.store, { meta: { ...meta, status: async () => "EXPIRED" } });
  assert.equal((await row(id)).status, "failed");
  assert.equal((await row(id)).error_code, "container_expired");
  const next = await queued({}, "missing-scope");
  await tick(db.store, {
    meta: {
      ...meta,
      create: async () => {
        throw new PublishingMetaError("meta_http_403_code_10", false);
      },
    },
  });
  assert.equal((await row(next)).status, "failed");
  assert.equal((await row(next)).error_code, "meta_http_403_code_10");
});
