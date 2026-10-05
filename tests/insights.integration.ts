import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { databaseFixture, restFixture, listen, json } from "./fixture";
import { encrypt } from "../src/lib/crypto";
import { hash } from "../src/lib/transport/api";
import {
  getAccountInsights,
  getMediaInsights,
  getAudienceInsights,
  listAccountMedia,
  getInsightsHistory,
  getInsightsSettings,
  setInsightsSettings,
} from "../src/lib/insights/api";
import { insightsMeta } from "../src/lib/insights/meta";
import {
  collect,
  ownedAccount,
  type InsightsPorts,
} from "../src/lib/insights/service";
import { drainInsights } from "../src/lib/insights/worker";
import { accountQuery, DAY, utcDay } from "../src/lib/insights/queries";
import type { TransportStore } from "../src/lib/transport/store";

let db: Awaited<ReturnType<typeof databaseFixture>>,
  rest: Server,
  graph: Server,
  api: string,
  graphBase: string,
  account: string;
const owner = randomUUID(),
  other = randomUUID(),
  key = "cd".repeat(32),
  ig = "17840001";
let mode = "ok",
  calls = 0,
  viewValue = 120,
  queries: URL[] = [];
const req = (
  path = "",
  bearer = "owner-token",
  method = "GET",
  value?: unknown,
) =>
  new Request(`${api}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
const ports = (signal?: AbortSignal): InsightsPorts => ({
  meta: insightsMeta(fetch, `${graphBase}/v26.0`, signal),
  encryptionKey: key,
  store: db.store,
});
const enabled = async (limit = 2) => {
  const r = await setInsightsSettings(account)(
    req("", "owner-token", "PUT", {
      enabled: true,
      media_limit: limit,
      retention_days: 90,
    }),
  );
  assert.equal(r.status, 200);
  return r.json();
};
const run = () => drainInsights(db.store, ports);
const snapshotRows = () =>
  db.pool.query(
    "SELECT * FROM instagram_insights_snapshots ORDER BY fetched_at",
  );
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
  graph = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fake-meta-token");
    const u = new URL(request.url!, graphBase);
    queries.push(u);
    calls++;
    assert.equal(u.searchParams.has("access_token"), false);
    if (mode === "permission")
      return json(
        response,
        {
          error: {
            code: 200,
            message: "provider secret must never be exposed",
          },
        },
        400,
      );
    if (mode === "rate") return json(response, { error: { code: 4 } }, 429);
    if (mode === "failure") return json(response, { error: { code: 2 } }, 500);
    if (u.pathname.endsWith("/media"))
      return json(response, {
        data: [
          {
            id: "99001",
            media_type: "VIDEO",
            timestamp: new Date().toISOString(),
            permalink: "https://www.instagram.com/reel/test/",
          },
          {
            id: "99002",
            media_type: "IMAGE",
            timestamp: new Date().toISOString(),
          },
        ].slice(0, Number(u.searchParams.get("limit"))),
        paging: {
          next: "https://untrusted.invalid/?access_token=secret",
          cursors: { after: "opaque-cursor" },
        },
      });
    if (u.pathname.endsWith("/insights")) {
      const names = u.searchParams.get("metric")!.split(",");
      if (mode === "missing") return json(response, { data: [] });
      if (mode === "unsupported" && names.includes("ig_reels_avg_watch_time"))
        return json(response, { error: { code: 100 } }, 400);
      return json(response, {
        data: names.map((name) => ({
          name,
          period: u.searchParams.get("period") ?? "lifetime",
          ...(u.searchParams.has("breakdown")
            ? {
                total_value: {
                  breakdowns: [
                    {
                      dimension_keys: [u.searchParams.get("breakdown")],
                      results: [{ dimension_values: ["TEST"], value: 2 }],
                    },
                  ],
                },
              }
            : u.pathname.includes(ig)
              ? { total_value: { value: viewValue } }
              : { values: [{ value: name === "comments" ? 0 : viewValue }] }),
        })),
      });
    }
    if (u.pathname.endsWith("/" + ig))
      return json(response, { followers_count: 1500, media_count: 20 });
    if (/\/(99001|99002|99899)$/.test(u.pathname))
      return json(response, {
        id: u.pathname.split("/").at(-1),
        owner: { id: u.pathname.endsWith("/99899") ? "999" : ig },
        media_type: u.pathname.endsWith("99002") ? "IMAGE" : "VIDEO",
        timestamp: new Date().toISOString(),
        permalink: "https://www.instagram.com/reel/test/",
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
  await db.pool.query("TRUNCATE instagram_accounts CASCADE");
  account = randomUUID();
  mode = "ok";
  calls = 0;
  viewValue = 120;
  queries = [];
  delete process.env.OWNER_API_TOKEN_HASH;
  delete process.env.OWNER_API_USER_ID;
  await db.pool.query(
    "INSERT INTO instagram_accounts(id,user_id,instagram_user_id,username,access_token_encrypted) VALUES($1,$2,$3,$4,$5)",
    [account, owner, ig, "fixture", encrypt("fake-meta-token", key)],
  );
});
test("real owner API stores windowed account insights, count observation, cache and same-day upsert", async () => {
  const r = await getAccountInsights(account, ports)(req());
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.profile.followers_count, 1500);
  assert.equal(out.cached, false);
  assert.ok(out.profile_observed_at);
  assert.equal(out.query.to, utcDay());
  const q = queries.find(
    (u) => u.searchParams.get("metric") === "follows_and_unfollows",
  )!;
  assert.equal(q.searchParams.get("breakdown"), "follow_type");
  const range = queries.find((u) => u.searchParams.has("since"))!;
  assert.equal(
    Number(range.searchParams.get("until")),
    (Date.parse(utcDay() + "T00:00:00Z") - 1000) / 1000,
  );
  const before = calls;
  assert.equal(
    (await (await getAccountInsights(account, ports)(req())).json()).cached,
    true,
  );
  assert.equal(calls, before);
  viewValue = 180;
  const changed = await (
    await getAccountInsights(account, ports)(req("?refresh=true"))
  ).json();
  assert.equal(
    changed.metrics.find((m: { name: string }) => m.name === "views")
      .total_value.value,
    180,
  );
  assert.equal((await snapshotRows()).rows.length, 1);
  const history = await getInsightsHistory(account)(req());
  assert.equal(history.status, 200);
  assert.equal((await history.json()).data[0].payload.metrics[0].period, "day");
});
test("media ownership is proven before insights; supported values survive missing optional metrics", async () => {
  mode = "unsupported";
  const r = await getMediaInsights(account, "99001", ports)(req());
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.media.id, "99001");
  assert.equal(
    out.metrics.find((m: { name: string }) => m.name === "comments").values[0]
      .value,
    0,
  );
  assert.deepEqual(out.unavailable_metrics, [
    { name: "ig_reels_avg_watch_time", reason: "provider_rejected" },
  ]);
  const before = calls;
  assert.equal(
    (await getMediaInsights(account, "99899", ports)(req())).status,
    404,
  );
  assert.equal(calls, before + 1);
  const list = await listAccountMedia(
    account,
    ports,
  )(req("?limit=1&after=previous"));
  const page = await list.json();
  assert.equal(page.next_cursor, "opaque-cursor");
  assert.ok(!JSON.stringify(page).includes("untrusted.invalid"));
  assert.equal(queries.at(-1)!.searchParams.get("after"), "previous");
});
test("owner isolation, permanent owner credential and validation stop before provider or settings mutation", async () => {
  for (const bearer of ["other-token", `bot_${"a".repeat(64)}`]) {
    const expected = bearer === "other-token" ? 404 : 401;
    assert.equal(
      (await getAccountInsights(account, ports)(req("", bearer))).status,
      expected,
    );
    assert.equal(
      (
        await setInsightsSettings(account)(
          req("", bearer, "PUT", { enabled: true }),
        )
      ).status,
      expected,
    );
  }
  assert.equal(calls, 0);
  const pat = `adm_${"c".repeat(64)}`;
  process.env.OWNER_API_TOKEN_HASH = hash(pat);
  process.env.OWNER_API_USER_ID = owner;
  assert.equal(
    (await getAccountInsights(account, ports)(req("", pat))).status,
    200,
  );
  for (const suffix of [
    "?metrics=invalid",
    "?from=2026-02-30",
    "?refresh=oops",
    "?from=2000-01-01",
  ])
    assert.equal(
      (await getAccountInsights(account, ports)(req(suffix))).status,
      400,
    );
  assert.equal(
    (await getMediaInsights(account, "bad/id", ports)(req())).status,
    400,
  );
  assert.equal(
    (await listAccountMedia(account, ports)(req("?limit=0"))).status,
    400,
  );
  assert.equal(
    (await getInsightsHistory(account)(req("?media_id="))).status,
    400,
  );
  assert.equal(
    (await getInsightsHistory(account)(req("", "other-token"))).status,
    404,
  );
});
test("audience breakdowns and absent provider data retain explicit availability without fake zeros", async () => {
  const response = await getAudienceInsights(
    account,
    ports,
  )(req("?breakdown=age&timeframe=this_week"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.metrics[0].total_value.breakdowns[0].dimension_keys, [
    "age",
  ]);
  mode = "missing";
  const empty = await (
    await getAudienceInsights(account, ports)(req("?refresh=true"))
  ).json();
  assert.deepEqual(empty.metrics, []);
  assert.deepEqual(empty.unavailable_metrics, [
    { name: "follower_demographics", reason: "no_data" },
  ]);
  assert.equal(
    (await getAudienceInsights(account, ports)(req("?timeframe=last_90_days")))
      .status,
    400,
  );
});
test("daily collection is opt-in, revisits three UTC days and saves bounded media and audience history", async () => {
  assert.equal(
    (await (await getInsightsSettings(account)(req())).json()).enabled,
    false,
  );
  assert.equal(await run(), 0);
  assert.equal(calls, 0);
  await enabled();
  assert.equal(await run(), 1);
  assert.equal(await run(), 0);
  const rows = (await snapshotRows()).rows;
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.kind === "account").length, 3);
  assert.equal(rows.filter((r) => r.kind === "media").length, 2);
  assert.equal(rows.filter((r) => r.kind === "audience").length, 1);
  const settings = await (await getInsightsSettings(account)(req())).json();
  assert.ok(settings.last_collected_at);
  assert.equal(settings.last_error, null);
  assert.ok(!("claim_token" in settings));
  assert.ok(!("access_token_encrypted" in settings));
});
test("multiple workers claim each account once; expired claims recover and disabling fences stale saves", async () => {
  await enabled(0);
  const batches = await Promise.all([
    db.store.rpc<any[]>("insights_claim"),
    db.store.rpc<any[]>("insights_claim"),
  ]);
  assert.equal(batches.flat().length, 1);
  const claim = batches.flat()[0];
  await db.pool.query(
    "UPDATE instagram_insights_settings SET lease_expires_at=now()-interval '1 second'",
  );
  const replacement = (await db.store.rpc<any[]>("insights_claim"))[0];
  assert.notEqual(replacement.claim_token, claim.claim_token);
  assert.equal(
    await db.store.rpc("insights_finish", {
      p_account: account,
      p_claim: claim.claim_token,
      p_error: null,
    }),
    false,
  );
  const a = await ownedAccount(owner, account);
  await setInsightsSettings(account)(
    req("", "owner-token", "PUT", { enabled: false }),
  );
  await assert.rejects(
    () =>
      collect(
        a,
        ig,
        accountQuery(new URLSearchParams()),
        ports(),
        true,
        replacement.claim_token,
      ),
    { message: "collection_cancelled" },
  );
  assert.equal((await snapshotRows()).rows.length, 0);
  assert.equal(await run(), 0);
});
test("provider permission/rate failures are explicit and back off without poisoning successful snapshots", async () => {
  await getAccountInsights(account, ports)(req());
  await enabled(0);
  mode = "permission";
  assert.equal(await run(), 1);
  const s = await (await getInsightsSettings(account)(req())).json();
  assert.equal(s.last_error, "insights_permission_required");
  assert.equal(s.last_collected_at, null);
  assert.ok(Date.parse(s.next_run_at) > Date.now() + 23 * 3600_000);
  assert.equal((await snapshotRows()).rows.length, 1);
  const r = await getAccountInsights(account, ports)(req("?refresh=true"));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "insights_permission_required" });
  mode = "rate";
  assert.equal(
    (await getAccountInsights(account, ports)(req("?refresh=true"))).status,
    429,
  );
  mode = "failure";
  assert.equal(
    (await getAccountInsights(account, ports)(req("?refresh=true"))).status,
    502,
  );
});
test("observation-day boundaries create new snapshots; retention cleanup, SQL grants and owner checks hold", async () => {
  await getAccountInsights(account, ports)(req());
  await db.pool.query(
    "UPDATE instagram_insights_snapshots SET collected_on=(now() AT TIME ZONE 'UTC')::date-1",
  );
  const next = await (await getAccountInsights(account, ports)(req())).json();
  assert.equal(next.cached, false);
  assert.equal((await snapshotRows()).rows.length, 2);
  await db.pool.query(
    "UPDATE instagram_insights_snapshots SET collected_on=(now() AT TIME ZONE 'UTC')::date-100 WHERE collected_on<(now() AT TIME ZONE 'UTC')::date",
  );
  assert.equal(await db.store.rpc("insights_cleanup"), 1);
  await assert.rejects(
    () =>
      db.store.rpc("insights_history", {
        p_user: other,
        p_account: account,
        p_kind: null,
        p_target: null,
        p_from: utcDay(Date.now() - DAY),
        p_to: utcDay(Date.now() + DAY),
        p_cursor: null,
      }),
    /not_found/,
  );
  const rights = (
    await db.pool.query(
      "SELECT has_table_privilege('authenticated','instagram_insights_snapshots','INSERT') i,has_table_privilege('anon','instagram_insights_snapshots','SELECT') s,has_function_privilege('authenticated','insights_claim(integer)','EXECUTE') e,has_function_privilege('service_role','insights_claim(integer)','EXECUTE') worker",
    )
  ).rows[0];
  assert.deepEqual(rights, { i: false, s: false, e: false, worker: true });
});
test("100 accounts progress in bounded claims while independent workers respect leases", async () => {
  await db.pool.query(
    "INSERT INTO instagram_accounts(id,user_id,instagram_user_id,username,access_token_encrypted) SELECT gen_random_uuid(),$1,(178420000+i)::text,'fixture'||i,$2 FROM generate_series(1,99) i",
    [owner, encrypt("fake-meta-token", key)],
  );
  await db.pool.query(
    "INSERT INTO instagram_insights_settings(account_id,user_id,enabled) SELECT id,user_id,true FROM instagram_accounts",
  );
  const seen = new Set<string>();
  for (let batch = 0; batch < 25; batch++) {
    const jobs = await db.store.rpc<
      { account_id: string; claim_token: string }[]
    >("insights_claim", { p_limit: 4 });
    assert.equal(jobs.length, 4);
    for (const j of jobs) {
      assert.ok(!seen.has(j.account_id));
      seen.add(j.account_id);
      assert.equal(
        await db.store.rpc("insights_finish", {
          p_account: j.account_id,
          p_claim: j.claim_token,
          p_error: null,
        }),
        true,
      );
    }
  }
  assert.equal(seen.size, 100);
  assert.deepEqual(await db.store.rpc("insights_claim", { p_limit: 4 }), []);
});
test("history pagination exposes all rows without overlap; expired and paused accounts do not contact Meta", async () => {
  for (let i = 0; i < 53; i++)
    await db.pool.query(
      "INSERT INTO instagram_insights_snapshots(user_id,account_id,kind,target_id,query_hash,query,payload) VALUES($1,$2,'account',$3,$4,'{}','{}')",
      [owner, account, ig, String(i)],
    );
  const first = await (await getInsightsHistory(account)(req())).json();
  assert.equal(first.data.length, 50);
  assert.ok(first.next_cursor);
  const second = await (
    await getInsightsHistory(account)(req("?cursor=" + first.next_cursor))
  ).json();
  assert.equal(second.data.length, 3);
  assert.equal(
    new Set([...first.data, ...second.data].map((r) => r.id)).size,
    53,
  );
  await db.pool.query(
    "UPDATE instagram_accounts SET token_expires_at=now()-interval '1 second'",
  );
  assert.equal((await getAccountInsights(account, ports)(req())).status, 409);
  assert.equal(calls, 0);
  await db.pool.query(
    "UPDATE instagram_accounts SET token_expires_at=NULL,paused_until=now()+interval '1 hour'",
  );
  assert.equal(
    (await getMediaInsights(account, "99001", ports)(req())).status,
    409,
  );
  assert.equal(calls, 0);
});
