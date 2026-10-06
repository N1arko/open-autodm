import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, json } from "./fixture";
import { decrypt } from "../src/lib/crypto";
import { hash } from "../src/lib/transport/api";
import { adsMeta } from "../src/lib/ads/meta";
import { type AdsPorts, account, read } from "../src/lib/ads/service";
import {
  connectAdsAccount,
  listAdsAccounts,
  getAdsAccount,
  updateAdsAccount,
  rotateAdsToken,
  listAdsObjects,
  getAdsInsights,
  getAdsStatus,
} from "../src/lib/ads/api";

let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  graph: Server,
  api: string,
  graphBase: string;
const user = randomUUID(),
  other = randomUUID(),
  key = "af".repeat(32),
  metaId = "2121416662133182";
const access = "fake-ads-token-at-least-20";
let mode = "ok",
  calls: URL[] = [],
  release: (() => void) | undefined,
  arrived: (() => void) | undefined;
const ports = (): AdsPorts => ({
  meta: adsMeta(fetch, `${graphBase}/v26.0`),
  encryptionKey: key,
  store: db.store,
});
const req = (
  query = "",
  bearer = "owner-token",
  method = "GET",
  value?: unknown,
) =>
  new Request(`${api}/ads${query ? `?${query}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
const connect = (bearer = "owner-token") =>
  connectAdsAccount(ports)(
    req("", bearer, "POST", {
      ad_account_id: `act_${metaId}`,
      access_token: access,
    }),
  );
const connected = async () => {
  const r = await connect();
  assert.equal(r.status, 201);
  return (await r.json()).account.id as string;
};
before(async () => {
  db = await databaseFixture();
  await db.pool.query("INSERT INTO auth.users(id) VALUES($1),($2)", [
    user,
    other,
  ]);
  rest = restFixture(db.pool, db.store, {
    "Bearer owner-token": user,
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
  graph = createServer(async (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, `Bearer ${access}`);
    const u = new URL(request.url!, graphBase);
    calls.push(u);
    assert.equal(u.searchParams.has("access_token"), false);
    assert.match(u.pathname, new RegExp(`^/v26\\.0/act_${metaId}(/|$)`));
    const edge = u.pathname.split("/").at(-1);
    if (mode === "hold" && edge === "campaigns") {
      arrived?.();
      await new Promise<void>((r) => {
        release = r;
      });
    }
    if (
      mode === "permission" ||
      (mode === "insights_permission" && edge === "insights")
    )
      return json(
        response,
        { error: { code: 200, message: "sensitive-provider-message" } },
        403,
      );
    if (mode === "rate")
      return json(response, { error: { code: 80004, message: "secret" } }, 400);
    if (mode === "expired")
      return json(response, { error: { code: 190 } }, 400);
    if (mode === "server") return json(response, { error: { code: 2 } }, 500);
    if (edge === `act_${metaId}`)
      return json(response, {
        id: `act_${metaId}`,
        account_id: mode === "wrong_account" ? "999" : metaId,
        name: "Fixture account",
        currency: "BRL",
        timezone_name: "America/Sao_Paulo",
        account_status: 1,
        amount_spent: "10050",
        spend_cap: "0",
        access_token: "must-be-stripped",
      });
    const paging = {
      next: "https://evil.invalid/?access_token=secret",
      cursors: { after: "opaque+next=" },
    };
    if (mode === "empty") return json(response, { data: [] });
    if (edge === "insights")
      return json(response, {
        data: [
          {
            account_id: mode === "foreign_row" ? "999" : metaId,
            date_start: "2026-10-04",
            date_stop: "2026-10-06",
            spend: "10.50",
            impressions: "0",
            actions: [],
            access_token: "strip",
          },
        ],
        paging,
      });
    if (edge === "instagram_accounts")
      return json(response, {
        data: [{ id: "17840000", username: "fixture.artist" }],
      });
    if (["campaigns", "adsets", "ads"].includes(edge!))
      return json(response, {
        data: [
          {
            id: "120001",
            account_id: mode === "foreign_row" ? "999" : metaId,
            name: "Fixture",
            status: "PAUSED",
            daily_budget: "500",
            campaign_id: "120001",
            adset_id: "120002",
            creative: {
              id: "120003",
              body: "Sample creative",
              access_token: "strip",
            },
            targeting: {
              age_min: 18,
              geo_locations: { countries: ["BR"] },
              access_token: "strip",
            },
            access_token: "strip",
          },
        ],
        paging,
      });
    json(response, { error: { code: 100 } }, 400);
  });
  graphBase = await listen(graph);
});
after(async () => {
  for (const s of [rest, graph]) {
    s?.closeAllConnections();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
  await db?.close();
});
beforeEach(async () => {
  await db.pool.query("TRUNCATE meta_ads_accounts CASCADE");
  mode = "ok";
  calls = [];
  release = undefined;
  arrived = undefined;
  delete process.env.OWNER_API_TOKEN_HASH;
  delete process.env.OWNER_API_USER_ID;
});

test("connect verifies account and Insights access, encrypts token and never returns it", async () => {
  const r = await connect(),
    out = await r.json();
  assert.equal(r.status, 201);
  assert.equal(calls.length, 2);
  assert.equal(out.account.ad_account_id, metaId);
  assert.equal(out.account.metadata.currency, "BRL");
  assert.deepEqual(out.capabilities, { read: true, manage: false });
  assert.equal(JSON.stringify(out).includes("access_token"), false);
  const stored = (await db.pool.query("SELECT * FROM meta_ads_accounts"))
    .rows[0];
  assert.equal(decrypt(stored.access_token_encrypted, key), access);
  assert.notEqual(stored.access_token_encrypted, access);
  const duplicate = await connect();
  assert.equal((await duplicate.json()).account.id, out.account.id);
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM meta_ads_accounts")).rows[0]
      .count,
    "1",
  );
});
test("import fails closed for missing Insights permission, wrong identity and bad input", async () => {
  mode = "insights_permission";
  const denied = await connect();
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "ads_permission_required" });
  mode = "wrong_account";
  assert.equal((await connect()).status, 502);
  mode = "ok";
  assert.equal(
    (
      await connectAdsAccount(ports)(
        req("", "owner-token", "POST", {
          ad_account_id: "../../me",
          access_token: access,
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM meta_ads_accounts")).rows[0]
      .count,
    "0",
  );
});
test("owner credential works; anonymous, integration and other-owner access cannot reach Meta", async () => {
  const id = await connected();
  calls = [];
  const pat = `adm_${"ab".repeat(32)}`;
  process.env.OWNER_API_TOKEN_HASH = hash(pat);
  process.env.OWNER_API_USER_ID = user;
  assert.equal((await listAdsAccounts(ports)(req("", pat))).status, 200);
  for (const bearer of ["", `bot_${"ab".repeat(32)}`, "invalid"])
    assert.equal(
      (await getAdsInsights(id, ports)(req("", bearer))).status,
      401,
    );
  assert.equal(
    (await getAdsInsights(id, ports)(req("", "other-token"))).status,
    404,
  );
  assert.equal((await getAdsAccount("../me", ports)(req())).status, 404);
  assert.equal(calls.length, 0);
  assert.equal(
    JSON.stringify(
      await (await getAdsAccount(id, ports)(req())).json(),
    ).includes("access_token"),
    false,
  );
});
test("campaigns, ad sets, ads and advertising Instagram identities are paginated and sanitized", async () => {
  const id = await connected();
  calls = [];
  for (const kind of [
    "campaigns",
    "adsets",
    "ads",
    "instagram_accounts",
  ] as const) {
    const r = await listAdsObjects(
      id,
      kind,
      ports,
    )(req("limit=1&after=opaque%2Bnext%3D"));
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.data.length, 1);
    assert.equal(
      out.next_cursor,
      kind === "instagram_accounts" ? null : "opaque+next=",
    );
    assert.equal(JSON.stringify(out).includes("access_token"), false);
    assert.equal(calls.at(-1)?.searchParams.get("after"), "opaque+next=");
  }
  mode = "foreign_row";
  assert.equal(
    (await listAdsObjects(id, "ads", ports)(req("refresh=true"))).status,
    502,
  );
});
test("Insights keep money strings, real zero and missing data; cache and refresh are explicit", async () => {
  const id = await connected();
  calls = [];
  const r = await getAdsInsights(
    id,
    ports,
  )(req("from=2026-10-04&to=2026-10-07&level=ad&daily=true"));
  const out = await r.json();
  assert.equal(r.status, 200);
  assert.equal(out.data[0].spend, "10.50");
  assert.equal(out.data[0].impressions, "0");
  assert.equal(out.data[0].reach, undefined);
  assert.equal(out.cached, false);
  assert.equal(out.timezone, "America/Sao_Paulo");
  assert.equal(out.currency, "BRL");
  assert.deepEqual(JSON.parse(calls[0]!.searchParams.get("time_range")!), {
    since: "2026-10-04",
    until: "2026-10-06",
  });
  assert.equal(
    (
      await (
        await getAdsInsights(
          id,
          ports,
        )(req("from=2026-10-04&to=2026-10-07&level=ad&daily=true"))
      ).json()
    ).cached,
    true,
  );
  assert.equal(calls.length, 1);
  mode = "empty";
  const empty = await getAdsInsights(id, ports)(req("refresh=true"));
  assert.deepEqual((await empty.json()).data, []);
});
test("invalid reports, unknown parameters and duplicate params never trigger upstream requests", async () => {
  const id = await connected();
  calls = [];
  for (const q of [
    "fields=secret",
    "level=ad&level=account",
    "from=2026-02-30",
    "to=2099-01-01",
    "daily=true&breakdown=bad",
    "limit=51",
    "refresh=1",
  ])
    assert.equal((await getAdsInsights(id, ports)(req(q))).status, 400);
  assert.equal(calls.length, 0);
});
test("Meta permission, expiry, rate and server failures stay explicit and preserve prior cache", async () => {
  const id = await connected();
  await getAdsInsights(id, ports)(req());
  for (const [state, status, error] of [
    ["permission", 403, "ads_permission_required"],
    ["expired", 409, "ads_token_unavailable"],
    ["rate", 429, "meta_rate_limited"],
    ["server", 502, "meta_unavailable"],
  ] as const) {
    mode = state;
    const r = await getAdsInsights(id, ports)(req("refresh=true"));
    assert.equal(r.status, status);
    assert.deepEqual(await r.json(), { error });
  }
  mode = "ok";
  assert.equal(
    (await (await getAdsInsights(id, ports)(req())).json()).cached,
    true,
  );
});
test("disable and token rotation invalidate cached data; stale in-flight reads are fenced", async () => {
  const id = await connected();
  const a = await account(user, id, ports());
  mode = "hold";
  const ready = new Promise<void>((r) => {
    arrived = r;
  });
  const pending = read(a, "campaigns", { limit: "25" }, ports());
  await ready;
  assert.equal(
    (
      await updateAdsAccount(
        id,
        ports,
      )(req("", "owner-token", "PATCH", { enabled: false }))
    ).status,
    200,
  );
  release!();
  await assert.rejects(pending, /ads_connection_changed/);
  assert.equal(
    (await db.pool.query("SELECT count(*) FROM meta_ads_cache")).rows[0].count,
    "0",
  );
  assert.equal((await getAdsInsights(id, ports)(req())).status, 409);
  mode = "ok";
  const rotate = await rotateAdsToken(
    id,
    ports,
  )(req("", "owner-token", "PUT", { access_token: access }));
  assert.equal(rotate.status, 200);
  assert.equal((await rotate.json()).enabled, false);
  assert.equal(
    (
      await updateAdsAccount(
        id,
        ports,
      )(req("", "owner-token", "PATCH", { enabled: true }))
    ).status,
    200,
  );
  assert.equal((await getAdsStatus(id, ports)(req())).status, 200);
});
test("same Meta account can have independently authorized owners, and SQL secrets remain service-only", async () => {
  const a = await connected();
  const b = (await (await connect("other-token")).json()).account.id;
  assert.notEqual(a, b);
  assert.equal(
    (await (await listAdsAccounts(ports)(req())).json()).data.length,
    1,
  );
  const result = await db.pool
    .query(`SELECT has_table_privilege('authenticated','public.meta_ads_accounts','SELECT') permitted,
    has_table_privilege('anon','public.meta_ads_cache','SELECT') cache,
    has_function_privilege('authenticated','public.ads_context(uuid,uuid)','EXECUTE') rpc`);
  assert.deepEqual(result.rows[0], {
    permitted: false,
    cache: false,
    rpc: false,
  });
});
test("100 account pagination and per-account cache retention remain bounded", async () => {
  const metadata = JSON.stringify({
    id: `act_${metaId}`,
    account_id: metaId,
    name: "Fixture",
    currency: "BRL",
    timezone_name: "UTC",
    account_status: 1,
  });
  await db.pool.query(
    `INSERT INTO meta_ads_accounts(user_id,ad_account_id,access_token_encrypted,metadata)
    SELECT $1,g::text,'encrypted',$2::jsonb FROM generate_series(1,100) g`,
    [user, metadata],
  );
  const first = await (await listAdsAccounts(ports)(req())).json();
  assert.equal(first.data.length, 50);
  assert.ok(first.next_cursor);
  const second = await (
    await listAdsAccounts(ports)(req(`cursor=${first.next_cursor}`))
  ).json();
  assert.equal(second.data.length, 50);
  assert.equal(second.next_cursor, null);
  assert.equal(
    new Set([...first.data, ...second.data].map((v) => v.id)).size,
    100,
  );
  const id = first.data[0].id;
  for (let i = 0; i < 105; i++)
    await db.store.rpc("ads_save", {
      p_user: user,
      p_account: id,
      p_revision: 1,
      p_hash: String(i),
      p_payload: { data: [] },
    });
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM meta_ads_cache WHERE account_id=$1",
        [id],
      )
    ).rows[0].count,
    "100",
  );
});
