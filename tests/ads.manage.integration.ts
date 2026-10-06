import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, json, body } from "./fixture";
import { encrypt } from "../src/lib/crypto";
import { adsMeta } from "../src/lib/ads/meta";
import { writeMeta } from "../src/lib/ads/writeMeta";
import {
  getManagement,
  setManagement,
  prepareAction,
  validateAction,
  executeAction,
  getOperation,
  listOperations,
  listAssets,
  type ManagePorts,
} from "../src/lib/ads/manage";
import { getAdsAccount } from "../src/lib/ads/api";

let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  graph: Server,
  api: string,
  graphBase: string,
  connection: string;
const user = randomUUID(),
  other = randomUUID(),
  key = "ab".repeat(32),
  access = "fixture-management-token-at-least-20";
let objects: Record<string, Record<string, unknown>>,
  posts: { path: string; params: Record<string, string> }[],
  reads: number,
  mode: string,
  release: (() => void) | undefined,
  arrived: (() => void) | undefined;
const ports = (): ManagePorts => ({
  store: db.store,
  encryptionKey: key,
  meta: adsMeta(fetch, graphBase),
  writer: writeMeta(fetch, graphBase),
  resolve: async (value) => ({
    url: new URL(value),
    addresses: [{ address: "8.8.8.8", family: 4 }],
  }),
});
const req = (
  value?: unknown,
  bearer = "owner",
  method = "POST",
  idempotency = randomUUID(),
  query = "",
) =>
  new Request(api + "/actions" + query, {
    method,
    headers: {
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotency,
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
const make = {
  action: "campaign.create",
  params: {
    name: "Paused fixture",
    objective: "OUTCOME_TRAFFIC",
    special_ad_categories: [],
  },
};
const activate = {
  action: "campaign.update",
  object_id: "100",
  params: { status: "ACTIVE" },
};
const enable = async (
  daily: string | null = "2500",
  lifetime: string | null = "10000",
) => {
  const r = await setManagement(
    connection,
    ports,
  )(
    req({
      enabled: true,
      currency: "BRL",
      max_daily_budget_minor: daily,
      max_lifetime_budget_minor: lifetime,
    }),
  );
  assert.equal(r.status, 200);
};
const prepare = async (value: unknown = make, idempotency = randomUUID()) => {
  const r = await prepareAction(
    connection,
    ports,
  )(req(value, "owner", "POST", idempotency));
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return r.json();
};
const execute = (o: { id: string; plan_hash: string }, confirm = false) =>
  executeAction(
    connection,
    o.id,
    ports,
  )(req({ plan_hash: o.plan_hash, confirm_spend: confirm }));
before(async () => {
  db = await databaseFixture();
  await db.pool.query("INSERT INTO auth.users(id) VALUES($1),($2)", [
    user,
    other,
  ]);
  rest = restFixture(db.pool, db.store, {
    "Bearer owner": user,
    "Bearer other": other,
  });
  api = await listen(rest);
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: api,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key-at-least-20",
    SUPABASE_SECRET_KEY: "fixture-secret-key-at-least-20-characters",
    TOKEN_ENCRYPTION_KEY: key,
    CRON_SECRET: "fixture-cron-secret-20",
  });
  graph = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + access);
    const u = new URL(request.url!, graphBase),
      path = u.pathname.slice(1);
    assert.equal(u.searchParams.has("access_token"), false);
    if (request.method === "POST") {
      const params = Object.fromEntries(
        new URLSearchParams(await body(request)),
      );
      posts.push({ path, params });
      assert.equal("access_token" in params, false);
      if (mode === "hold") {
        arrived?.();
        await new Promise<void>((r) => {
          release = r;
        });
      }
      if (mode === "server")
        return json(
          response,
          { error: { code: 2, message: "never-expose-provider-secret" } },
          500,
        );
      if (mode === "denied")
        return json(
          response,
          {
            error: {
              code: 200,
              error_subcode: 42,
              message: "never-expose-provider-secret",
            },
          },
          400,
        );
      if (mode === "malformed") return json(response, { unexpected: "secret" });
      if (params.execution_options === '["validate_only"]')
        return json(response, { success: true });
      if (objects[path]) {
        Object.assign(objects[path], params);
        return json(response, { success: true });
      }
      assert.equal(
        params.status,
        path.endsWith("adcreatives") || path.endsWith("advideos")
          ? undefined
          : "PAUSED",
      );
      return json(response, {
        id: "501",
        access_token: "must-not-be-returned",
      });
    }
    assert.equal(request.method, "GET");
    reads++;
    if (objects[path]) return json(response, objects[path]);
    if (path === "100/adsets")
      return json(response, {
        data: Object.values(objects).filter(
          (v) => v.id === "200" || v.id === "201",
        ),
      });
    if (path.endsWith("/promote_pages"))
      return json(response, { data: [{ id: "700", name: "Page" }] });
    if (path.endsWith("/instagram_accounts"))
      return json(response, {
        data: [{ id: "800", username: "fixture.artist" }],
      });
    if (path.endsWith("/adimages"))
      return json(response, {
        data: [{ hash: "a".repeat(32), name: "Image" }],
      });
    if (path.endsWith("/advideos"))
      return json(response, {
        data: [
          {
            id: "900",
            title: "Video",
            status: {
              video_status: mode === "processing" ? "processing" : "ready",
            },
          },
        ],
      });
    json(response, { error: { code: 100 } }, 400);
  });
  graphBase = await listen(graph);
});
beforeEach(async () => {
  await db.pool.query("TRUNCATE meta_ads_accounts CASCADE");
  const row = await db.store.rpc<{ id: string }>("ads_connect", {
    p_user: user,
    p_meta_id: "123",
    p_token: encrypt(access, key),
    p_metadata: {
      id: "act_123",
      account_id: "123",
      name: "Account",
      currency: "BRL",
      timezone_name: "America/Noronha",
      account_status: 1,
    },
  });
  connection = row.id;
  objects = {
    "100": {
      id: "100",
      account_id: "123",
      name: "Campaign",
      status: "PAUSED",
      objective: "OUTCOME_TRAFFIC",
      daily_budget: "1000",
      lifetime_budget: "0",
      updated_time: "2026-10-06T00:00:00+0000",
    },
    "200": {
      id: "200",
      account_id: "123",
      campaign_id: "100",
      name: "Adset",
      status: "PAUSED",
      optimization_goal: "LINK_CLICKS",
      daily_budget: "0",
      lifetime_budget: "0",
      updated_time: "2026-10-06T00:00:00+0000",
    },
    "300": {
      id: "300",
      account_id: "123",
      name: "Creative",
      object_type: "SHARE",
    },
    "400": {
      id: "400",
      account_id: "123",
      campaign_id: "100",
      adset_id: "200",
      status: "PAUSED",
      name: "Ad",
      creative: { id: "300" },
      updated_time: "2026-10-06T00:00:00+0000",
    },
    "999": { id: "999", account_id: "456", name: "Foreign" },
  };
  posts = [];
  reads = 0;
  mode = "ok";
  release = undefined;
  arrived = undefined;
});
after(async () => {
  await Promise.all([
    new Promise<void>((r) => rest.close(() => r())),
    new Promise<void>((r) => graph.close(() => r())),
  ]);
  await db.close();
});

test("management is opt-in, owner-only and account-scoped, including policy and audit SQL grants", async () => {
  assert.equal((await prepareAction(connection, ports)(req(make))).status, 409);
  for (const bearer of ["", "bot_" + "a".repeat(64), "other"]) {
    assert.equal(
      (await prepareAction(connection, ports)(req(make, bearer))).status,
      bearer === "other" ? 404 : 401,
    );
    assert.equal(
      (
        await setManagement(
          connection,
          ports,
        )(
          req(
            {
              enabled: true,
              currency: "BRL",
              max_daily_budget_minor: null,
              max_lifetime_budget_minor: null,
            },
            bearer,
          ),
        )
      ).status,
      bearer === "other" ? 404 : 401,
    );
  }
  assert.equal(reads, 0);
  assert.equal(posts.length, 0);
  assert.equal(
    (
      await setManagement(
        connection,
        ports,
      )(
        req({
          enabled: true,
          currency: "USD",
          max_daily_budget_minor: null,
          max_lifetime_budget_minor: null,
        }),
      )
    ).status,
    400,
  );
  await enable();
  assert.equal(
    (
      await (
        await getManagement(connection, ports)(req(undefined, "owner", "GET"))
      ).json()
    ).enabled,
    true,
  );
  assert.equal(
    (
      await (
        await getAdsAccount(connection, ports)(req(undefined, "owner", "GET"))
      ).json()
    ).capabilities.manage,
    true,
  );
  const grants = await db.pool.query(
    "SELECT has_table_privilege('authenticated','meta_ads_operations','SELECT') can_read,has_function_privilege('anon','ads_operation_begin(uuid,uuid,uuid,text,boolean)','EXECUTE') can_write",
  );
  assert.deepEqual(grants.rows[0], { can_read: false, can_write: false });
});
test("paused campaign creation is durable, replayed exactly once, and validation cannot create objects", async () => {
  await enable();
  const k = randomUUID(),
    o = await prepare(make, k);
  assert.equal(posts.length, 0);
  assert.equal(o.plan.requires_spend_confirmation, false);
  const same = await prepareAction(
    connection,
    ports,
  )(req(make, "owner", "POST", k));
  assert.equal((await same.json()).id, o.id);
  const bad = await prepareAction(
    connection,
    ports,
  )(
    req(
      { ...make, params: { ...make.params, name: "Changed" } },
      "owner",
      "POST",
      k,
    ),
  );
  assert.equal(bad.status, 409);
  const validation = await validateAction(connection, ports)(req(make));
  assert.equal(validation.status, 200);
  assert.equal(posts[0]!.params.execution_options, '["validate_only"]');
  const r = await execute(o);
  assert.equal(r.status, 200);
  const done = await r.json();
  assert.equal(done.state, "succeeded");
  assert.equal(done.result.object_id, "501");
  assert.equal(posts[1]!.params.status, "PAUSED");
  assert.equal(posts[1]!.params.is_adset_budget_sharing_enabled, "false");
  assert.equal(posts[1]!.params.execution_options, undefined);
  assert.equal((await execute(o)).status, 200);
  assert.equal(posts.length, 2);
  const audit = await (
    await listOperations(connection, ports)(req(undefined, "owner", "GET"))
  ).json();
  assert.equal(audit.data[0].state, "succeeded");
  assert.equal(JSON.stringify(audit).includes(access), false);
});
test("activation and budget changes require exact plan confirmation and per-campaign currency caps", async () => {
  await enable();
  const o = await prepare(activate);
  assert.deepEqual(o.plan.budget, {
    daily_budget_minor: "1000",
    lifetime_budget_minor: "0",
  });
  assert.equal((await execute(o)).status, 409);
  assert.equal(posts.length, 0);
  assert.equal(
    (
      await executeAction(
        connection,
        o.id,
        ports,
      )(req({ plan_hash: "f".repeat(64), confirm_spend: true }))
    ).status,
    409,
  );
  assert.equal((await execute(o, true)).status, 200);
  assert.equal(posts[0]!.params.status, "ACTIVE");
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req({
          action: "campaign.update",
          object_id: "100",
          params: { daily_budget: "2501" },
        }),
      )
    ).status,
    409,
  );
  await enable(null, null);
  assert.equal(
    (await prepareAction(connection, ports)(req(activate))).status,
    409,
  );
  const pause = await prepare({
    action: "campaign.update",
    object_id: "100",
    params: { status: "PAUSED" },
  });
  assert.equal((await execute(pause)).status, 200);
});
test("ABO budgets are summed across siblings; foreign objects and malformed creates cannot cause writes", async () => {
  await enable("1000");
  objects["100"]!.daily_budget = "0";
  objects["200"]!.daily_budget = "600";
  objects["201"] = { ...objects["200"], id: "201", daily_budget: "600" };
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req({
          action: "campaign.update",
          object_id: "200",
          params: { status: "ACTIVE" },
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await prepareAction(connection, ports)(req(activate))).status,
    409,
  );
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req({
          action: "ad.update",
          object_id: "999",
          params: { status: "PAUSED" },
        }),
      )
    ).status,
    404,
  );
  for (const action of [
    { ...make, params: { ...make.params, status: "ACTIVE" } },
    {
      action: "campaign.update",
      object_id: "100/evil",
      params: { status: "ACTIVE" },
    },
    { action: "campaign.update", object_id: "100", params: {} },
    {
      action: "campaign.create",
      params: { ...make.params, daily_budget: 500 },
    },
  ])
    assert.equal(
      (await prepareAction(connection, ports)(req(action))).status,
      400,
    );
  assert.equal(posts.length, 0);
});
test("a changed Meta parent, connection, policy or expired plan prevents execution", async () => {
  await enable();
  const changed = await prepare(activate);
  objects["100"]!.daily_budget = "1200";
  const r = await execute(changed, true);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).state, "cancelled");
  assert.equal(posts.length, 0);
  const expired = await prepare(make);
  await db.pool.query(
    "UPDATE meta_ads_operations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  assert.equal((await execute(expired)).status, 409);
  const revised = await prepare(make);
  await enable();
  assert.equal((await execute(revised)).status, 409);
  const rotated = await prepare(make);
  await db.store.rpc("ads_update", {
    p_user: user,
    p_account: connection,
    p_enabled: false,
  });
  assert.equal((await execute(rotated)).status, 409);
  assert.equal(posts.length, 0);
});
test("concurrent execution is serialized and token/policy changes are fenced until the receipt is saved", async () => {
  await enable();
  const o = await prepare(make);
  mode = "hold";
  const started = new Promise<void>((r) => {
    arrived = r;
  });
  const first = execute(o);
  await started;
  assert.equal((await execute(o)).status, 202);
  await assert.rejects(
    () =>
      db.store.rpc("ads_update", {
        p_user: user,
        p_account: connection,
        p_enabled: false,
      }),
    /operation_in_progress/,
  );
  await assert.rejects(
    () =>
      db.store.rpc("ads_rotate", {
        p_user: user,
        p_account: connection,
        p_token: "changed",
        p_metadata: {},
      }),
    /operation_in_progress/,
  );
  assert.equal(
    (
      await setManagement(
        connection,
        ports,
      )(
        req({
          enabled: false,
          currency: "BRL",
          max_daily_budget_minor: null,
          max_lifetime_budget_minor: null,
        }),
      )
    ).status,
    409,
  );
  release!();
  assert.equal((await first).status, 200);
  assert.equal(posts.length, 1);
});
test("provider rejection is final; ambiguous writes are never retried and orphaned execution becomes uncertain", async () => {
  await enable();
  const denied = await prepare(make);
  mode = "denied";
  const d = await execute(denied);
  assert.equal(d.status, 403);
  const rejected = await d.json();
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.result.provider_code, 200);
  assert.equal(JSON.stringify(rejected).includes("provider-secret"), false);
  assert.equal((await execute(denied)).status, 409);
  assert.equal(posts.length, 1);
  for (const m of ["server", "malformed"]) {
    mode = m;
    const uncertain = await prepare(make);
    const r = await execute(uncertain);
    assert.equal(r.status, 409);
    assert.equal((await r.json()).state, "uncertain");
    const n: number = posts.length;
    assert.equal((await execute(uncertain)).status, 409);
    assert.equal(posts.length, n);
  }
  mode = "ok";
  const orphan = await prepare(make);
  await db.store.rpc("ads_operation_begin", {
    p_user: user,
    p_account: connection,
    p_operation: orphan.id,
    p_hash: orphan.plan_hash,
    p_confirm: false,
  });
  await db.pool.query(
    "UPDATE meta_ads_operations SET updated_at=now()-interval '3 minutes' WHERE id=$1",
    [orphan.id],
  );
  assert.equal(
    (
      await (
        await getOperation(
          connection,
          orphan.id,
          ports,
        )(req(undefined, "owner", "GET"))
      ).json()
    ).state,
    "uncertain",
  );
  assert.equal(
    (
      await getOperation(
        connection,
        randomUUID(),
        ports,
      )(req(undefined, "owner", "GET"))
    ).status,
    404,
  );
});
test("creatives, paused ads and video imports enforce asset ownership and Meta-ready video state", async () => {
  await enable();
  const image = {
    action: "creative.create",
    params: {
      name: "Image",
      creative: {
        kind: "image",
        page_id: "700",
        instagram_user_id: "800",
        image_hash: "a".repeat(32),
        link: "https://example.com/",
        message: "Fixture",
        call_to_action: "LEARN_MORE",
      },
    },
  };
  assert.equal((await execute(await prepare(image))).status, 200);
  const spec = JSON.parse(posts[0]!.params.object_story_spec!);
  assert.equal(spec.instagram_user_id, "800");
  assert.equal(spec.link_data.image_hash, "a".repeat(32));
  assert.equal("instagram_actor_id" in spec, false);
  const bad = {
    ...image,
    params: {
      ...image.params,
      creative: { ...image.params.creative, page_id: "701" },
    },
  };
  assert.equal((await prepareAction(connection, ports)(req(bad))).status, 404);
  assert.equal(
    (
      await execute(
        await prepare({
          action: "ad.create",
          params: { name: "Ad", adset_id: "200", creative_id: "300" },
        }),
      )
    ).status,
    200,
  );
  assert.equal(posts[1]!.params.status, "PAUSED");
  const video = {
    action: "creative.create",
    params: {
      name: "Video",
      creative: {
        kind: "video",
        page_id: "700",
        video_id: "900",
        image_url: "https://example.com/poster.jpg",
        message: "Fixture",
      },
    },
  };
  mode = "processing";
  assert.equal(
    (await prepareAction(connection, ports)(req(video))).status,
    409,
  );
  mode = "ok";
  assert.equal((await execute(await prepare(video))).status, 200);
  assert.equal(
    (
      await execute(
        await prepare({
          action: "video.upload",
          params: { name: "Video", file_url: "https://example.com/video.mp4" },
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await validateAction(
        connection,
        ports,
      )(
        req({
          action: "video.upload",
          params: { name: "Video", file_url: "https://example.com/video.mp4" },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await listAssets(
        connection,
        "pages",
        ports,
      )(req(undefined, "owner", "GET"))
    ).status,
    200,
  );
});
