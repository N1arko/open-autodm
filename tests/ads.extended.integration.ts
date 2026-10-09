import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, json, body } from "./fixture";
import { encrypt } from "../src/lib/crypto";
import { adsMeta } from "../src/lib/ads/meta";
import { writeMeta } from "../src/lib/ads/writeMeta";
import {
  prepareAction,
  executeAction,
  validateAction,
  listResources,
  prepareManaged,
  executeManaged,
  getPixelCode,
  type ManagePorts,
} from "../src/lib/ads/manage";
import {
  listRules,
  setRule,
  listRuleRuns,
  drainOptimization,
  ruleInput,
} from "../src/lib/ads/optimization";
import {
  credentialStatus,
  monitorCredentials,
} from "../src/lib/ads/credentials";
import { account } from "../src/lib/ads/service";
import { actionInput } from "../src/lib/ads/actions";

let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  graph: Server,
  api: string,
  graphBase: string,
  connection: string;
const user = randomUUID(),
  other = randomUUID(),
  key = "ab".repeat(32),
  access = "fixture-resource-token-at-least-20";
let posts: { path: string; params: Record<string, string> }[],
  reads: string[],
  daily: string,
  mode: string,
  businessLinked: boolean;
const ports = (): ManagePorts => ({
  store: db.store,
  encryptionKey: key,
  meta: adsMeta(fetch, graphBase),
  writer: writeMeta(fetch, graphBase),
  resolve: async (v) => ({
    url: new URL(v),
    addresses: [{ address: "8.8.8.8", family: 4 }],
  }),
});
const req = (value?: unknown, bearer = "owner", method = "POST", query = "") =>
  new Request(api + "/action" + query, {
    method,
    headers: {
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
const config = () =>
  ruleInput.parse({
    name: "Guard",
    enabled: true,
    mode: "observe",
    level: "campaign",
    object_ids: ["100"],
    window_days: 3,
    min_spend_minor: "1000",
    min_impressions: 100,
    max_changes_per_day: 2,
    condition: { metric: "spend_minor", operator: "gt", threshold: 1500 },
    action: { kind: "pause" },
  });
const prepare = async (a: unknown) => {
  const r = await prepareAction(connection, ports)(req(a));
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
    SUPABASE_SECRET_KEY: "fixture-secret-key-at-least-20-characters",
    TOKEN_ENCRYPTION_KEY: key,
    CRON_SECRET: "fixture-cron-secret-20",
  });
  graph = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + access);
    const u = new URL(request.url!, graphBase),
      path = u.pathname.slice(1);
    reads.push(path);
    if (request.method === "POST") {
      const params = Object.fromEntries(
        new URLSearchParams(await body(request)),
      );
      posts.push({ path, params });
      if (mode === "server")
        return json(
          response,
          { error: { code: 2, message: "provider-secret" } },
          500,
        );
      if (mode === "denied")
        return json(
          response,
          { error: { code: 200, message: "provider-secret" } },
          400,
        );
      if (path === "500/users")
        return json(response, {
          audience_id: "500",
          num_received: JSON.parse(params.payload!).data.length,
          num_invalid_entries: 0,
        });
      if (path === "100") {
        if (params.daily_budget) daily = params.daily_budget;
        return json(response, { success: true });
      }
      if (["600", "500", "700", "800", "900"].includes(path))
        return json(response, { success: true });
      return json(response, { id: "991", access_token: "provider-secret" });
    }
    if (path === "debug_token")
      return json(response, {
        data: {
          is_valid: true,
          type: "USER",
          app_id: "111",
          expires_at: Math.floor(Date.now() / 1000) + 2 * 86400,
          data_access_expires_at: 0,
          scopes: ["ads_read", "ads_management"],
          access_token: "provider-secret",
        },
      });
    if (path === "act_123")
      return json(response, {
        id: "act_123",
        account_id: "123",
        ...(businessLinked ? { business: { id: "444" } } : {}),
      });
    if (path === "444/owned_ad_accounts" || path === "444/client_ad_accounts")
      return json(response, { data: [] });
    if (path === "600")
      return json(response, {
        id: "600",
        code: "<script>pixel fixture</script>",
      });
    if (path === "100")
      return json(response, {
        id: "100",
        account_id: "123",
        status: "ACTIVE",
        name: "Campaign",
        objective: "OUTCOME_TRAFFIC",
        daily_budget: daily,
        lifetime_budget: "0",
      });
    if (path === "999")
      return json(response, {
        id: "999",
        account_id: "456",
        status: "ACTIVE",
        name: "Foreign",
        objective: "OUTCOME_TRAFFIC",
        daily_budget: "1000",
      });
    if (path === "100/adsets") return json(response, { data: [] });
    if (path === "act_123/insights")
      return json(response, {
        data: [
          {
            account_id: "123",
            account_currency: "BRL",
            campaign_id: "100",
            date_start: "2026-10-01",
            date_stop: "2026-10-03",
            spend: "20.00",
            impressions: "200",
            clicks: "5",
          },
        ],
      });
    const list: Record<string, unknown[]> = {
      "act_123/adspixels": [{ id: "600", name: "Pixel" }],
      "act_123/customaudiences": [
        { id: "500", account_id: "123", name: "Audience", subtype: "CUSTOM" },
      ],
      "444/owned_product_catalogs": [
        { id: "700", name: "Catalog", vertical: "commerce" },
      ],
      "700/products": [{ id: "800", name: "Product", retailer_id: "sku" }],
      "700/product_sets": [{ id: "900", name: "Set" }],
    };
    if (list[path]) return json(response, { data: list[path] });
    return json(response, { error: { code: 100 } }, 400);
  });
  graphBase = await listen(graph);
});
beforeEach(async () => {
  await db.pool.query("TRUNCATE meta_ads_accounts CASCADE");
  const a = await db.store.rpc<{ id: string }>("ads_connect", {
    p_user: user,
    p_meta_id: "123",
    p_token: encrypt(access, key),
    p_metadata: {
      id: "act_123",
      account_id: "123",
      name: "Account",
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
    p_daily: "2500",
    p_lifetime: "10000",
  });
  posts = [];
  reads = [];
  daily = "1000";
  mode = "ok";
  businessLinked = true;
});
after(async () => {
  graph.closeAllConnections();
  rest.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => graph.close(() => r())),
    new Promise<void>((r) => rest.close(() => r())),
  ]);
  await db.close();
});
test("owner resources remain scoped to their account, business and catalog before preparation and again before writing", async () => {
  const objects = [
    { action: "pixel.create", params: { name: "Pixel" } },
    { action: "pixel.update", object_id: "600", params: { name: "Renamed" } },
    {
      action: "audience.create",
      params: {
        name: "Visitors",
        subtype: "WEBSITE",
        pixel_id: "600",
        retention_days: 30,
        rule: { url: { i_contains: "example.org" } },
      },
    },
    {
      action: "audience.update",
      object_id: "500",
      params: { name: "Renamed" },
    },
    { action: "catalog.create", params: { business_id: "444", name: "Shop" } },
    {
      action: "catalog.update",
      object_id: "700",
      params: { business_id: "444", name: "Shop" },
    },
    {
      action: "product.create",
      params: {
        business_id: "444",
        catalog_id: "700",
        retailer_id: "sku",
        name: "Shirt",
        description: "Shirt",
        image_url: "https://example.org/image.jpg",
        url: "https://example.org/product",
        price: 1500,
        currency: "BRL",
        brand: "Brand",
        condition: "new",
        availability: "in stock",
      },
    },
    {
      action: "product.update",
      object_id: "800",
      params: { business_id: "444", catalog_id: "700", inventory: 5 },
    },
    {
      action: "productset.create",
      params: {
        business_id: "444",
        catalog_id: "700",
        name: "Shirts",
        filter: { retailer_id: { eq: "sku" } },
      },
    },
    {
      action: "productset.update",
      object_id: "900",
      params: { business_id: "444", catalog_id: "700", name: "Renamed" },
    },
  ];
  for (const v of objects) {
    const o = await prepare(v);
    assert.equal(o.plan.meta_validated, false);
    const r = await execute(o);
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal((await r.json()).state, "succeeded");
  }
  assert.equal(posts.length, 10);
  assert(
    posts.every(
      (p) =>
        p.params.status === undefined &&
        p.params.execution_options === undefined &&
        p.params.business_id === undefined &&
        p.params.catalog_id === undefined,
    ),
  );
  assert.equal(
    (await validateAction(connection, ports)(req(objects[0]))).status,
    400,
  );
  const o = await prepare(objects[5]);
  businessLinked = false;
  const denied = await execute(o);
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).state, "cancelled");
  assert.equal(posts.length, 10);
});
test("anonymous/foreign owners and foreign resources never reach provider writes; resource reads are paginated", async () => {
  for (const bearer of ["", "other"]) {
    const r = await listResources(
      connection,
      "pixels",
      ports,
    )(req(undefined, bearer, "GET"));
    assert([401, 404].includes(r.status));
  }
  assert.equal(reads.length, 0);
  assert.equal(
    (
      await listResources(
        connection,
        "products",
        ports,
      )(req(undefined, "owner", "GET", "?business_id=444&catalog_id=700"))
    ).status,
    200,
  );
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req({
          action: "pixel.update",
          object_id: "999",
          params: { name: "Foreign" },
        }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req({
          action: "product.update",
          object_id: "999",
          params: { business_id: "444", catalog_id: "700", name: "Foreign" },
        }),
      )
    ).status,
    404,
  );
  assert.equal(posts.length, 0);
});
test("credential health strips provider secrets, reports expiry/scopes and persists only sanitized metadata", async () => {
  const r = await credentialStatus(
    connection,
    ports,
  )(req(undefined, "owner", "GET"));
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.health.status, "expiring");
  assert.equal(v.health.permissions.catalog_management, false);
  assert(!JSON.stringify(v).includes(access));
  assert(!JSON.stringify(v).includes("provider-secret"));
  const saved = await credentialStatus(
    connection,
    ports,
  )(req(undefined, "owner", "GET"));
  assert.equal((await saved.json()).cached, true);
  assert.equal(await monitorCredentials(db.store, ports), 0);
  await db.pool.query(
    "UPDATE meta_ads_accounts SET revision=revision+1 WHERE id=$1",
    [connection],
  );
  assert.equal(await monitorCredentials(db.store, ports), 1);
});
test("observation rules run in the background without writes, prove ownership, and retain decision evidence", async () => {
  const create = await setRule(
    connection,
    null,
    ports,
  )(req({ config: config() }));
  assert.equal(create.status, 201);
  const rule = await create.json();
  assert.equal(await drainOptimization(db.store, ports), 1);
  assert.equal(posts.length, 0);
  const audit = await listRuleRuns(
    connection,
    rule.id,
    ports,
  )(req(undefined, "owner", "GET"));
  const v = await audit.json();
  assert.equal(v.data[0].outcome, "suggested");
  assert.equal(v.data[0].evidence.spend_minor, 2000);
  assert.equal(v.data[0].evidence.action.params.status, "PAUSED");
  assert.equal(
    (await listRules(connection, ports)(req(undefined, "other", "GET"))).status,
    404,
  );
  assert.equal(
    (
      await setRule(
        connection,
        null,
        ports,
      )(req({ config: { ...config(), object_ids: ["999"] } }))
    ).status,
    404,
  );
});
test("execution is explicit, uses durable operations, respects cooldown and cannot override campaign caps", async () => {
  const c = {
    ...config(),
    mode: "execute",
    action: {
      kind: "adjust_daily_budget",
      percent: 20,
      min_budget_minor: "500",
      max_budget_minor: "2000",
    },
  };
  assert.equal(
    (await setRule(connection, null, ports)(req({ config: c }))).status,
    409,
  );
  const created = await setRule(
    connection,
    null,
    ports,
  )(req({ config: c, authorize_changes: true }));
  assert.equal(created.status, 201);
  const rule = await created.json();
  assert.equal(await drainOptimization(db.store, ports), 1);
  assert.equal(daily, "1200");
  assert.equal(posts.length, 1);
  await db.pool.query(
    "UPDATE meta_ads_rules SET next_run_at=now() WHERE id=$1",
    [rule.id],
  );
  await drainOptimization(db.store, ports);
  assert.equal(posts.length, 1);
  await db.pool.query(
    "UPDATE meta_ads_rule_runs SET created_at=now()-interval '2 days' WHERE rule_id=$1",
    [rule.id],
  );
  await db.pool.query(
    "UPDATE meta_ads_rules SET next_run_at=now() WHERE id=$1",
    [rule.id],
  );
  await db.pool.query(
    "UPDATE meta_ads_policy SET max_daily_budget_minor='1300',revision=revision+1 WHERE account_id=$1",
    [connection],
  );
  await drainOptimization(db.store, ports);
  assert.equal(posts.length, 1);
  assert.equal(daily, "1200");
});
test("multiple workers lease a rule once; disabling or changing a rule fences already prepared actions", async () => {
  const c = { ...config(), mode: "execute" };
  const res = await setRule(
    connection,
    null,
    ports,
  )(req({ config: c, authorize_changes: true }));
  const rule = await res.json();
  const batches = await Promise.all([
    db.store.rpc<any[]>("ads_rule_claim", { p_limit: 2 }),
    db.store.rpc<any[]>("ads_rule_claim", { p_limit: 2 }),
  ]);
  assert.equal(batches.flat().length, 1);
  const claim = batches.flat()[0];
  const a = await account(user, connection, ports()),
    o = await prepareManaged(
      a,
      actionInput.parse({
        action: "campaign.update",
        object_id: "100",
        params: { status: "PAUSED" },
      }),
      randomUUID(),
      ports(),
    );
  await db.store.rpc("ads_rule_record", {
    p_rule: rule.id,
    p_claim: claim.claim_token,
    p_object: "100",
    p_mode: "execute",
    p_outcome: "reserved",
    p_evidence: {},
    p_operation: o.id,
  });
  const disabled = await setRule(
    connection,
    rule.id,
    ports,
  )(req({ config: { ...c, enabled: false } }));
  assert.equal(disabled.status, 200);
  await assert.rejects(
    executeManaged(a, o.id, o.plan_hash, true, ports()),
    /automation_cancelled/,
  );
  assert.equal(posts.length, 0);
});
test("uncertain provider writes disable the rule and are never automatically retried", async () => {
  const c = { ...config(), mode: "execute" };
  const r = await setRule(
    connection,
    null,
    ports,
  )(req({ config: c, authorize_changes: true }));
  const rule = await r.json();
  mode = "server";
  await drainOptimization(db.store, ports);
  assert.equal(posts.length, 1);
  const row = (
    await db.pool.query(
      "SELECT enabled,last_error FROM meta_ads_rules WHERE id=$1",
      [rule.id],
    )
  ).rows[0];
  assert.equal(row.enabled, false);
  assert.equal(row.last_error, "automation_execution_uncertain");
  assert.equal(await drainOptimization(db.store, ports), 0);
  assert.equal(posts.length, 1);
});
test("new rules, histories and credential metadata remain service-only in SQL", async () => {
  for (const t of [
    "meta_ads_rules",
    "meta_ads_rule_runs",
    "meta_ads_credential_health",
  ]) {
    const row = (
      await db.pool.query(
        "SELECT has_table_privilege('anon',$1,'SELECT') a,has_table_privilege('authenticated',$1,'UPDATE') b",
        [t],
      )
    ).rows[0];
    assert.equal(row.a, false);
    assert.equal(row.b, false);
  }
  const r = (
    await db.pool.query(
      "SELECT has_function_privilege('anon','ads_rule_claim(integer)','EXECUTE') a",
    )
  ).rows[0];
  assert.equal(r.a, false);
});

test("pixel installation code and hashed audience batches require account ownership and explicit data-use authorization", async () => {
  const r = await getPixelCode(
    connection,
    "600",
    ports,
  )(req(undefined, "owner", "GET"));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, "600");
  assert.equal(
    (
      await getPixelCode(
        connection,
        "999",
        ports,
      )(req(undefined, "owner", "GET"))
    ).status,
    404,
  );
  const a = {
    action: "audience.users.add",
    object_id: "500",
    params: {
      data_use_authorized: true,
      payload: {
        schema: ["EMAIL", "PHONE"],
        data: [["a".repeat(64), "b".repeat(64)]],
      },
    },
  };
  const o = await prepare(a),
    res = await execute(o);
  assert.equal(res.status, 200);
  const v = await res.json();
  assert.equal(v.result.num_received, 1);
  assert.equal(posts[0]!.path, "500/users");
  assert.equal(posts[0]!.params.data_use_authorized, undefined);
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(req({ ...a, params: { ...a.params, data_use_authorized: false } }))
    ).status,
    400,
  );
  assert.equal(
    (
      await prepareAction(
        connection,
        ports,
      )(
        req({
          ...a,
          params: {
            ...a.params,
            payload: { schema: ["EMAIL"], data: [["user@example.org"]] },
          },
        }),
      )
    ).status,
    400,
  );
});
test("budget automation cannot be enabled without owner limits and day quotas survive repeated evaluations", async () => {
  const c = {
    ...config(),
    mode: "execute",
    max_changes_per_day: 1,
    cooldown_seconds: 86400,
    action: {
      kind: "adjust_daily_budget",
      percent: 20,
      min_budget_minor: "500",
      max_budget_minor: "2000",
    },
  };
  await db.pool.query(
    "UPDATE meta_ads_policy SET max_daily_budget_minor=NULL WHERE account_id=$1",
    [connection],
  );
  assert.equal(
    (
      await setRule(
        connection,
        null,
        ports,
      )(req({ config: c, authorize_changes: true }))
    ).status,
    409,
  );
  await db.pool.query(
    "UPDATE meta_ads_policy SET max_daily_budget_minor='2500' WHERE account_id=$1",
    [connection],
  );
  const res = await setRule(
    connection,
    null,
    ports,
  )(req({ config: c, authorize_changes: true }));
  assert.equal(res.status, 201);
  const rule = await res.json();
  await drainOptimization(db.store, ports);
  assert.equal(posts.length, 1);
  // Clear only the object cooldown by simulating a different first target, retaining the rolling-day quota.
  await db.pool.query(
    "UPDATE meta_ads_rule_runs SET object_id='200' WHERE rule_id=$1",
    [rule.id],
  );
  await db.pool.query(
    "UPDATE meta_ads_rules SET next_run_at=now() WHERE id=$1",
    [rule.id],
  );
  await drainOptimization(db.store, ports);
  assert.equal(posts.length, 1);
});
