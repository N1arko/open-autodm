import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, json, body } from "./fixture";
import { adsMeta } from "../src/lib/ads/meta";
import { writeMeta } from "../src/lib/ads/writeMeta";
import {
  prepareAction,
  executeAction,
  validateAction,
  type ManagePorts,
} from "../src/lib/ads/manage";
import { stageImage } from "../src/lib/ads/uploads";
import {
  readTemplates,
  saveTemplate,
  archiveTemplate,
} from "../src/lib/ads/templates";
import {
  searchTargeting,
  getCreative,
  getPageInstagram,
} from "../src/lib/ads/discovery";
import { encrypt } from "../src/lib/crypto";
let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  graph: Server,
  base: string,
  api: string,
  connection: string;
const user = randomUUID(),
  other = randomUUID(),
  key = "cd".repeat(32),
  access = "parity-fixture-token",
  hash = "ab".repeat(16),
  image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP3sAAAAASUVORK5CYII=",
    "base64",
  );
let posts: { path: string; params: Record<string, string> }[],
  mode: string,
  readPaths: string[],
  pageVisible: boolean,
  group: Record<string, unknown>;
const ports = (): ManagePorts => ({
  store: db.store,
  encryptionKey: key,
  meta: adsMeta(fetch, base),
  writer: writeMeta(fetch, base),
  resolve: async (u) => ({
    url: new URL(u),
    addresses: [{ address: "8.8.8.8", family: 4 }],
  }),
});
const req = (
  value?: unknown,
  bearer = "owner",
  method = "POST",
  q = "",
  idempotency = randomUUID(),
) =>
  new Request(api + "/test" + q, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotency,
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
const welcome = {
  greeting: "oi ⟡",
  questions: [{ title: "valor?", response: null }],
  ai_generated_icebreakers: false,
};
const direct = (extra: Record<string, unknown> = {}) => ({
  action: "creative.create",
  params: {
    name: "Direct fixture",
    creative: {
      kind: "instagram_direct",
      page_id: "700",
      instagram_user_id: "900",
      instagram_legacy_id: "901",
      adset_id: "200",
      media: { kind: "image", image_hash: hash },
      message: "fixture",
      welcome,
      degrees_of_freedom_spec: {
        creative_features_spec: {
          image_touchups: { enroll_status: "OPT_OUT" },
          music_generation: { enroll_status: "OPT_OUT" },
        },
      },
      contextual_multi_ads: { enroll_status: "OPT_OUT" },
      ...extra,
    },
  },
});
const prepare = async (value: unknown) => {
  const r = await prepareAction(connection, ports)(req(value));
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  return r.json();
};
const execute = (o: { id: string; plan_hash: string }) =>
  executeAction(connection, o.id, ports)(req({ plan_hash: o.plan_hash }));
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
    SUPABASE_SECRET_KEY: "fixture-secret-key-at-least-20",
    TOKEN_ENCRYPTION_KEY: key,
    CRON_SECRET: "fixture-cron-secret-20",
  });
  graph = createServer(async (r, res) => {
    assert.equal(r.headers.authorization, "Bearer " + access);
    const u = new URL(r.url!, base),
      path = u.pathname.slice(1);
    readPaths.push(path);
    if (r.method === "POST") {
      const params = Object.fromEntries(new URLSearchParams(await body(r)));
      posts.push({ path, params });
      if (mode === "uncertain") return json(res, { error: { code: 2 } }, 500);
      if (mode === "malformed") return json(res, { unexpected: true });
      if (mode === "rate-validation") {
        res.setHeader("Retry-After", "120");
        return json(res, { error: { code: 4 } }, 429);
      }
      if (params.execution_options) return json(res, { success: true });
      if (path.endsWith("adimages")) {
        assert.deepEqual(Buffer.from(params.bytes!, "base64"), image);
        return json(res, { images: { file: { hash, width: 1, height: 1 } } });
      }
      return json(res, { id: "401" });
    }
    if (mode === "rate-read") {
      res.setHeader("Retry-After", "120");
      return json(res, { error: { code: 4 } }, 429);
    }
    if (path === "100")
      return json(res, {
        id: "100",
        account_id: "123",
        name: "campaign",
        status: "PAUSED",
        objective: "OUTCOME_ENGAGEMENT",
        daily_budget: "3000",
      });
    if (path === "200") return json(res, group);
    if (path === "400")
      return json(res, {
        id: "400",
        account_id: mode === "foreign" ? "999" : "123",
        name: "creative",
        object_type: "SHARE",
        object_story_spec: {
          page_id: "700",
          instagram_user_id: "900",
          link_data: { page_welcome_message: JSON.stringify(welcome) },
        },
        degrees_of_freedom_spec: {
          creative_features_spec: {
            image_animation: { enroll_status: "OPT_OUT" },
          },
        },
        media_sourcing_spec: {
          images: [
            {
              hash: "cd".repeat(16),
              source: "padding",
              opt_in_status: "opt_in",
            },
          ],
        },
        contextual_multi_ads: { enroll_status: "OPT_OUT" },
      });
    if (path === "700")
      return json(res, {
        id: "700",
        name: "Page",
        instagram_business_account: {
          id: mode === "mismatch" ? "999" : "900",
          username: "fixture",
        },
      });
    if (path === "900")
      return json(res, {
        id: "900",
        ig_id: 901,
        username: "fixture",
        media_count: 1,
      });
    if (path === "900/media")
      return json(res, {
        data: [{ id: "902", caption: "fixture caption", media_type: "IMAGE" }],
      });
    if (path.endsWith("promote_pages"))
      return json(res, {
        data: pageVisible ? [{ id: "700", name: "Page" }] : [],
      });
    if (path.endsWith("adimages"))
      return json(res, {
        data: [{ hash, name: "fixture", width: 1, height: 1 }],
      });
    if (path === "search" || path.endsWith("targetingsearch"))
      return json(res, {
        data: [
          {
            key: "253249",
            name: "Florianópolis",
            type: "city",
            country_code: "BR",
          },
        ],
        paging: {
          next: "https://graph.facebook.com/evil?access_token=secret",
          cursors: { after: "catalog-next" },
        },
      });
    json(res, { error: { code: 100 } }, 400);
  });
  base = await listen(graph);
});
after(async () => {
  await Promise.all([
    new Promise<void>((r) => rest.close(() => r())),
    new Promise<void>((r) => graph.close(() => r())),
  ]);
  await db.close();
});
beforeEach(async () => {
  posts = [];
  readPaths = [];
  mode = "ok";
  pageVisible = true;
  group = {
    id: "200",
    account_id: "123",
    name: "group",
    status: "PAUSED",
    campaign_id: "100",
    optimization_goal: "CONVERSATIONS",
    billing_event: "IMPRESSIONS",
    destination_type: "INSTAGRAM_DIRECT",
    promoted_object: { page_id: "700" },
  };
  await db.pool.query("DELETE FROM meta_ads_accounts");
  const a = await db.store.rpc<{ id: string }>("ads_connect", {
    p_user: user,
    p_meta_id: "123",
    p_token: encrypt(access, key),
    p_metadata: {
      id: "act_123",
      account_id: "123",
      name: "Fixture",
      currency: "BRL",
      timezone_name: "America/Sao_Paulo",
      account_status: 1,
    },
  });
  connection = a.id;
  await db.store.rpc("ads_policy_set", {
    p_user: user,
    p_account: connection,
    p_enabled: true,
    p_currency: "BRL",
    p_daily: "3000",
    p_lifetime: "21000",
  });
});
test("local multipart image stays private until one durable image upload; owner, expiry and uncertain guards hold", async () => {
  const form = new FormData();
  form.append("file", new File([image], "fixture.png", { type: "image/png" }));
  const upload = await stageImage(
    connection,
    ports,
  )(
    new Request(api + "/upload", {
      method: "POST",
      headers: { Authorization: "Bearer owner" },
      body: form,
    }),
  );
  assert.equal(upload.status, 201);
  const staged = await upload.json();
  assert.equal(staged.meta_uploaded, false);
  assert.equal(JSON.stringify(staged).includes("bytes_encrypted"), false);
  assert.equal(posts.length, 0);
  const sql = (
    await db.pool.query(
      "SELECT bytes_encrypted FROM meta_ads_image_uploads WHERE id=$1",
      [staged.id],
    )
  ).rows[0];
  assert.equal(sql.bytes_encrypted.includes(image.toString("base64")), false);
  const action = { action: "image.upload", params: { upload_id: staged.id } };
  const validation = await validateAction(connection, ports)(req(action));
  assert.equal(validation.status, 400);
  assert.equal(posts.length, 0);
  const o = await prepare(action),
    r = await execute(o);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.hash, hash);
  assert.equal((await execute(o)).status, 200);
  assert.equal(posts.length, 1);
  assert.equal(
    (await prepareAction(connection, ports)(req(action, "other"))).status,
    404,
  );
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM meta_ads_image_uploads")).rows[0]
      .count,
    "0",
  );
  assert.equal(
    (await prepareAction(connection, ports)(req(action))).status,
    404,
  );
  await db.store.rpc("ads_creative_cleanup");
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM meta_ads_image_uploads")).rows[0]
      .count,
    "0",
  );
});
test("expired staging cancels a prepared image upload before a provider POST", async () => {
  const row = await db.store.rpc<{ id: string }>("ads_image_stage", {
    p_user: user,
    p_account: connection,
    p_metadata: {
      name: "fixture",
      width: 1,
      height: 1,
      mime: "image/png",
      size: image.length,
      sha256: (await import("node:crypto"))
        .createHash("sha256")
        .update(image)
        .digest("hex"),
    },
    p_bytes: encrypt(image.toString("base64"), key),
  });
  const o = await prepare({
    action: "image.upload",
    params: { upload_id: row.id },
  });
  await db.pool.query(
    "UPDATE meta_ads_image_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
    [row.id],
  );
  const r = await execute(o);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).state, "cancelled");
  assert.equal(posts.length, 0);
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(req({ action: "image.upload", params: { upload_id: row.id } }))
    ).status,
    404,
  );
});
test("image upload timeout/malformed provider acknowledgement is uncertain and cannot be replayed", async () => {
  const row = await db.store.rpc<{ id: string }>("ads_image_stage", {
    p_user: user,
    p_account: connection,
    p_metadata: {
      name: "fixture",
      width: 1,
      height: 1,
      mime: "image/png",
      size: image.length,
      sha256: (await import("node:crypto"))
        .createHash("sha256")
        .update(image)
        .digest("hex"),
    },
    p_bytes: encrypt(image.toString("base64"), key),
  });
  const o = await prepare({
    action: "image.upload",
    params: { upload_id: row.id },
  });
  mode = "malformed";
  const r = await execute(o);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).state, "uncertain");
  await execute(o);
  assert.equal(posts.length, 1);
});
test("Direct preparation proves exact Page/Instagram/deeplink/adset configuration, frozen template and explicit controls", async () => {
  const saved = await saveTemplate(
    connection,
    undefined,
    ports,
  )(req({ name: "Portuguese", body: welcome }));
  assert.equal(saved.status, 201);
  const template = await saved.json();
  const { welcome: _welcome, ...creative } = (direct() as any).params.creative;
  const action = {
    action: "creative.create",
    params: {
      name: "Direct",
      creative: { ...creative, template: { id: template.id, version: 1 } },
    },
  };
  const o = await prepare(action);
  assert.equal(o.plan.meta_validated, true);
  assert.equal(
    o.plan.effective_action.params.creative.welcome.greeting,
    "oi ⟡",
  );
  const changed = await saveTemplate(
    connection,
    template.id,
    ports,
  )(
    req({
      name: "Portuguese",
      expected_version: 1,
      body: { ...welcome, greeting: "new" },
    }),
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (
      await saveTemplate(
        connection,
        template.id,
        ports,
      )(req({ name: "Portuguese", expected_version: 1, body: welcome }))
    ).status,
    409,
  );
  assert.equal((await execute(o)).status, 200);
  const actual = posts.filter((p) => !p.params.execution_options);
  assert.equal(actual.length, 1);
  assert.equal(
    JSON.parse(actual[0]!.params.page_welcome_message!).text_format.message
      .text,
    "oi ⟡",
  );
  assert.equal(
    JSON.parse(actual[0]!.params.contextual_multi_ads!).enroll_status,
    "OPT_OUT",
  );
  assert.equal(
    (
      await readTemplates(
        connection,
        template.id,
        ports,
      )(req(undefined, "owner", "GET", "?version=1")).then((r) => r.json())
    ).body.greeting,
    "oi ⟡",
  );
  assert.equal(
    (
      await archiveTemplate(
        connection,
        template.id,
        ports,
      )(req({ expected_version: 2 }))
    ).status,
    200,
  );
  assert.equal(
    (
      await readTemplates(
        connection,
        template.id,
        ports,
      )(req(undefined, "other", "GET"))
    ).status,
    404,
  );
  await db.pool.query(
    "INSERT INTO meta_ads_chat_template_versions(template_id,version,body) SELECT $1,n,$2::jsonb FROM generate_series(3,100) n",
    [template.id, JSON.stringify(welcome)],
  );
  await db.pool.query(
    "UPDATE meta_ads_chat_templates SET version=100,archived=false WHERE id=$1",
    [template.id],
  );
  assert.equal(
    (
      await saveTemplate(connection, template.id, ports)(
        req({ name: "Portuguese", expected_version: 100, body: welcome }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await archiveTemplate(connection, template.id, ports)(
        req({ expected_version: 100 }),
      )
    ).status,
    200,
  );
});
test("wrong Direct identity, group destination or foreign placement image is rejected before creating anything", async () => {
  mode = "mismatch";
  assert.equal(
    (await prepareAction(connection, ports)(req(direct()))).status,
    409,
  );
  assert.equal(posts.length, 0);
  mode = "ok";
  group.destination_type = "MESSENGER";
  assert.equal(
    (await prepareAction(connection, ports)(req(direct()))).status,
    409,
  );
  assert.equal(posts.length, 0);
  group.destination_type = "INSTAGRAM_DIRECT";
  const feed = {
    images: [
      { hash, adlabels: [{ name: "feed" }] },
      { hash: "ef".repeat(16), adlabels: [{ name: "story" }] },
    ],
    bodies: [{ text: "fixture" }],
    call_to_action_types: ["INSTAGRAM_MESSAGE"],
    ad_formats: ["SINGLE_IMAGE"],
    optimization_type: "PLACEMENT",
    asset_customization_rules: [
      {
        customization_spec: {
          publisher_platforms: ["instagram"],
          instagram_positions: ["story"],
        },
        image_label: { name: "story" },
      },
    ],
  };
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(req(direct({ asset_feed_spec: feed })))
    ).status,
    404,
  );
  assert.equal(posts.length, 0);
});
test("Page resolution uses scoped Page or owned-creative proof; full reads preserve padding controls and media captions", async () => {
  pageVisible = false;
  assert.equal(
    (
      await getPageInstagram(
        connection,
        "700",
        false,
        ports,
      )(req(undefined, "owner", "GET"))
    ).status,
    404,
  );
  const r = await getPageInstagram(
    connection,
    "700",
    false,
    ports,
  )(req(undefined, "owner", "GET", "?creative_id=400"));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).instagram.ig_id, "901");
  const media = await getPageInstagram(
    connection,
    "700",
    true,
    ports,
  )(req(undefined, "owner", "GET", "?creative_id=400"));
  assert.equal((await media.json()).data[0].caption, "fixture caption");
  const c = await getCreative(
    connection,
    "400",
    ports,
  )(req(undefined, "owner", "GET"));
  assert.equal(
    (await c.json()).creative.media_sourcing_spec.images[0].source,
    "padding",
  );
  mode = "foreign";
  assert.equal(
    (
      await getCreative(
        connection,
        "400",
        ports,
      )(req(undefined, "owner", "GET"))
    ).status,
    404,
  );
});
test("padding absent from the image library requires proof from an owned creative and is frozen before writing", async () => {
  const sourcing = {
    images: [
      {
        hash: "cd".repeat(16),
        source: "padding",
        opt_in_status: "opt_in",
        variant_types: ["SQUARE"],
      },
    ],
  };
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(req(direct({ media_sourcing_spec: sourcing })))
    ).status,
    404,
  );
  const o = await prepare(
    direct({ media_sourcing_spec: { ...sourcing, source_creative_id: "400" } }),
  );
  assert.equal((await execute(o)).status, 200);
  const sent = JSON.parse(
    posts.find((p) => !p.params.execution_options)!.params.media_sourcing_spec!,
  );
  assert.equal(sent.images[0].hash, "cd".repeat(16));
  assert.equal("source_creative_id" in sent, false);
  mode = "foreign";
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req(
          direct({
            media_sourcing_spec: { ...sourcing, source_creative_id: "400" },
          }),
        ),
      )
    ).status,
    404,
  );
});
test("Direct placement payload uses identity-only story and keeps the exact app destination inside asset-feed CTA", async () => {
  const feed = {
    images: [{ hash, adlabels: [{ name: "original" }] }],
    bodies: [{ text: "fixture" }],
    call_to_action_types: ["INSTAGRAM_MESSAGE"],
    ad_formats: ["SINGLE_IMAGE"],
    optimization_type: "PLACEMENT",
    asset_customization_rules: [
      {
        customization_spec: {
          publisher_platforms: ["instagram"],
          instagram_positions: ["stream"],
        },
        image_label: { name: "original" },
      },
      {
        customization_spec: {
          publisher_platforms: ["instagram"],
          instagram_positions: ["story"],
        },
        image_label: { name: "original" },
      },
    ],
  };
  const o = await prepare(direct({ asset_feed_spec: feed }));
  assert.equal((await execute(o)).status, 200);
  const sent = posts.find((p) => !p.params.execution_options)!.params;
  assert.deepEqual(JSON.parse(sent.object_story_spec!), {
    page_id: "700",
    instagram_user_id: "900",
  });
  const spec = JSON.parse(sent.asset_feed_spec!);
  assert.equal(
    spec.call_to_actions[0].value.app_link,
    "instagram://direct?userid=901",
  );
  assert.equal(spec.link_urls[0].website_url, "https://www.instagram.com/");
});
test("catalog search returns a bounded cursor, uses fixed global geo search, and preserves explicit rate guidance", async () => {
  const r = await searchTargeting(
    connection,
    ports,
  )(req(undefined, "owner", "GET", "?kind=cities&q=Florianopolis&country=BR"));
  const result = await r.json();
  assert.equal(result.data[0].key, "253249");
  assert.equal(result.next_cursor, "catalog-next");
  assert.equal(JSON.stringify(result).includes("access_token"), false);
  assert.equal(readPaths.at(-1), "search");
  assert.equal(
    (
      await searchTargeting(
        connection,
        ports,
      )(req(undefined, "owner", "GET", "?kind=cities&q=x&fields=token"))
    ).status,
    400,
  );
  mode = "rate-read";
  const limited = await searchTargeting(
    connection,
    ports,
  )(req(undefined, "owner", "GET", "?kind=interests&q=music"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "120");
  assert.equal((await limited.json()).retry_scope, "read");
  mode = "rate-validation";
  const key = randomUUID(),
    validation = await prepareAction(
      connection,
      ports,
    )(req(direct(), "owner", "POST", "", key));
  assert.equal(validation.status, 429);
  assert.equal((await validation.json()).retry_scope, "validation");
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM meta_ads_operations")).rows[0]
      .count,
    "0",
  );
  mode = "ok";
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(req(direct(), "owner", "POST", "", key))
    ).status,
    201,
  );
});
test("new image and template tables/RPCs are inaccessible to public SQL roles", async () => {
  for (const table of [
    "meta_ads_image_uploads",
    "meta_ads_chat_templates",
    "meta_ads_chat_template_versions",
  ]) {
    await db.pool.query("SET ROLE authenticated");
    await assert.rejects(
      () => db.pool.query(`SELECT * FROM ${table}`),
      /permission denied/,
    );
    await db.pool.query("RESET ROLE");
  }
  await db.pool.query("SET ROLE anon");
  await assert.rejects(
    () => db.pool.query("SELECT ads_creative_cleanup()"),
    /permission denied/,
  );
  await db.pool.query("RESET ROLE");
});
