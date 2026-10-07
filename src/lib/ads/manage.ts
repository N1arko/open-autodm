import { z } from "zod";
import {
  ApiError,
  apiRoute,
  hash,
  jsonBody,
  owner,
  respond,
} from "@/lib/transport/api";
import { resolveEndpoint, publicAddress } from "@/lib/transport/http";
import {
  account,
  defaultAdsPorts,
  token,
  type AdsPorts,
  type AdsAccount,
} from "./service";
import {
  actionInput,
  budgetWithin,
  policyInput,
  stable,
  type Action,
  type Policy,
} from "./actions";
import {
  writeMeta,
  WriteMetaError,
  type MetaObject,
  type Writer,
} from "./writeMeta";

export interface ManagePorts extends AdsPorts {
  writer: Writer;
  resolve: typeof resolveEndpoint;
}
export async function resolveMediaUrl(value: string) {
  try {
    const resolved = await resolveEndpoint(value);
    if (
      resolved.url.protocol !== "https:" ||
      resolved.addresses.some((v) => !publicAddress(v.address))
    )
      throw new Error();
    return resolved;
  } catch {
    throw new ApiError(400, "invalid_media_url");
  }
}
export const defaultManagePorts = (): ManagePorts => ({
  ...defaultAdsPorts(),
  writer: writeMeta(
    fetch,
    "https://graph.facebook.com/v26.0",
    Date.now() + 45000,
  ),
  resolve: resolveMediaUrl,
});
interface Plan {
  action: Action;
  currency: string;
  dependencies: Record<string, unknown>;
  requires_spend_confirmation: boolean;
  budget: { daily_budget_minor: string; lifetime_budget_minor: string } | null;
  meta_validated: boolean;
}
interface Operation {
  id: string;
  account_id: string;
  plan: Plan;
  plan_hash: string;
  state: string;
  result: unknown;
  request_hash: string;
  expires_at: string;
  account_revision: number;
  policy_revision: number;
}
const uuid = z.string().uuid(),
  keySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
function failure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (
    [
      "plan_hash_mismatch",
      "plan_expired",
      "ads_connection_changed",
      "spend_confirmation_required",
      "operation_in_progress",
      "idempotency_conflict",
    ].includes(message)
  )
    throw new ApiError(409, message);
  throw error;
}
async function policy(a: AdsAccount, p: ManagePorts): Promise<Policy> {
  const result = await p.store.rpc<Policy | null>("ads_policy", {
    p_user: a.user_id,
    p_account: a.id,
  });
  return (
    result ?? {
      enabled: false,
      currency: a.metadata.currency,
      max_daily_budget_minor: null,
      max_lifetime_budget_minor: null,
      revision: 0,
    }
  );
}
function enabled(a: AdsAccount, pol: Policy, p: ManagePorts) {
  const access = token(a, p);
  if (!pol.enabled) throw new ApiError(409, "ads_management_disabled");
  if (pol.currency !== a.metadata.currency)
    throw new ApiError(409, "currency_changed");
  return access;
}
async function plan(
  a: AdsAccount,
  pol: Policy,
  action: Action,
  p: ManagePorts,
  validate: boolean,
): Promise<Plan> {
  const access = enabled(a, pol, p),
    deps: Record<string, unknown> = {},
    params = action.params as Record<string, unknown>;
  let validateInstagramCreative = false;
  const object = async (id: string, kind: string) => {
    const v = await p.writer.object(a.ad_account_id, id, kind, access);
    deps[`${kind}:${id}`] = v;
    return v;
  };
  const asset = async (
    kind: "pages" | "images" | "videos",
    id: string,
  ) => {
    let after: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await p.writer.assets(a.ad_account_id, access, kind, after);
      const row = page.data.find((v) =>
        "hash" in v ? v.hash === id : "id" in v && v.id === id,
      );
      if (row) {
        if (
          kind === "videos" &&
          (!("status" in row) || row.status?.video_status !== "ready")
        )
          throw new ApiError(409, "video_not_ready");
        deps[`${kind}:${id}`] = row;
        return;
      }
      if (!page.next_cursor) break;
      after = page.next_cursor;
    }
    throw new ApiError(404, "ads_asset_not_found");
  };
  let campaign: MetaObject | undefined,
    adset: MetaObject | undefined,
    target: MetaObject | undefined;
  const entity = action.action.split(".")[0]!;
  if ("object_id" in action) {
    target = await object(action.object_id!, entity);
    if (entity === "campaign") campaign = target;
    if (entity === "adset") adset = target;
    if (entity === "ad") {
      if (!target.adset_id || !target.campaign_id)
        throw new WriteMetaError("meta_invalid_response");
      adset = await object(target.adset_id, "adset");
      if (adset.campaign_id !== target.campaign_id)
        throw new WriteMetaError("meta_invalid_response");
    }
  }
  if (action.action === "adset.create")
    campaign = await object(action.params.campaign_id!, "campaign");
  if (action.action === "ad.create")
    adset = await object(action.params.adset_id, "adset");
  if (adset) {
    if (!adset.campaign_id) throw new WriteMetaError("meta_invalid_response");
    campaign = await object(adset.campaign_id, "campaign");
  }
  if ("creative_id" in params && params.creative_id)
    await object(String(params.creative_id), "creative");
  if (action.action === "video.upload") await p.resolve(action.params.file_url);
  if (action.action === "creative.create") {
    const c = action.params.creative;
    if (c.kind === "image" || c.kind === "video") {
      await asset("pages", c.page_id);
      if (c.kind === "image") {
        if (c.image_hash) await asset("images", c.image_hash);
        else await p.resolve(c.image_url!);
      } else {
        await asset("videos", c.video_id);
        await p.resolve(c.image_url);
      }
    }
    if ("instagram_user_id" in c && c.instagram_user_id) {
      // The account's instagram_accounts edge can omit usable identities.
      // Validate this exact creative for this ad account, including on execution.
      validateInstagramCreative = true;
      deps[`instagram:${c.instagram_user_id}`] = { id: c.instagram_user_id };
    }
    if (c.kind === "facebook_post")
      await asset("pages", c.object_story_id.split("_")[0]!);
  }
  const changingBudget = !!(params.daily_budget || params.lifetime_budget);
  const risk =
    params.status === "ACTIVE" ||
    (action.action.endsWith(".update") &&
      Object.keys(params).some((k) => !["name", "status"].includes(k)));
  let budget: Plan["budget"] = null;
  if (changingBudget || risk || action.action === "adset.create") {
    let daily = 0n,
      lifetime = 0n;
    const amounts = (v: Record<string, unknown>) => {
      daily += BigInt(String(v.daily_budget ?? "0"));
      lifetime += BigInt(String(v.lifetime_budget ?? "0"));
    };
    if (action.action === "campaign.create") amounts(params);
    else if (campaign) {
      const cbo =
        BigInt(campaign.daily_budget ?? "0") > 0n ||
        BigInt(campaign.lifetime_budget ?? "0") > 0n;
      if (cbo) {
        if (entity === "adset" && changingBudget)
          throw new ApiError(409, "campaign_budget_controls_adset");
        amounts(entity === "campaign" ? { ...campaign, ...params } : campaign);
      } else if (entity === "campaign" && changingBudget) {
        throw new ApiError(409, "budget_model_change_unsupported");
      } else {
        const rows = await p.writer.adsets(
          a.ad_account_id,
          campaign.id,
          access,
        );
        deps[`adsets:${campaign.id}`] = rows;
        for (const row of rows) {
          if (["DELETED", "ARCHIVED"].includes(row.status ?? "")) continue;
          const v =
            adset?.id === row.id && entity === "adset"
              ? { ...row, ...params }
              : row;
          if (
            BigInt(String(v.daily_budget ?? "0")) === 0n &&
            BigInt(String(v.lifetime_budget ?? "0")) === 0n
          )
            throw new ApiError(409, "budget_required");
          amounts(v);
        }
        if (action.action === "adset.create") amounts(params);
      }
    } else throw new ApiError(409, "budget_required");
    budgetWithin(daily, lifetime, pol);
    budget = {
      daily_budget_minor: daily.toString(),
      lifetime_budget_minor: lifetime.toString(),
    };
  }
  // Prevent switching a daily budget into lifetime mode through a partial update.
  if (
    target &&
    changingBudget &&
    ((params.daily_budget && BigInt(target.lifetime_budget ?? "0") > 0n) ||
      (params.lifetime_budget && BigInt(target.daily_budget ?? "0") > 0n))
  )
    throw new ApiError(409, "budget_model_change_unsupported");
  if (
    target &&
    entity === "adset" &&
    params.lifetime_budget &&
    !params.end_time &&
    !target.end_time
  )
    throw new ApiError(400, "lifetime_budget_requires_end_time");
  const metaValidated = validate || validateInstagramCreative;
  if (metaValidated)
    await p.writer.mutate(a.ad_account_id, access, action, true);
  return {
    action,
    currency: pol.currency,
    dependencies: deps,
    requires_spend_confirmation: risk,
    budget,
    meta_validated: metaValidated,
  };
}
export const getManagement = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    return respond(await policy(a, p));
  });
export const setManagement = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      body = await jsonBody(request, policyInput);
    if (body.currency !== a.metadata.currency)
      throw new ApiError(400, "currency_mismatch");
    return respond(
      await p.store.rpc("ads_policy_set", {
        p_user: a.user_id,
        p_account: a.id,
        p_enabled: body.enabled,
        p_currency: body.currency,
        p_daily: body.max_daily_budget_minor,
        p_lifetime: body.max_lifetime_budget_minor,
      }),
    );
  });
export const prepareAction = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      action = await jsonBody(request, actionInput),
      pol = await policy(a, p);
    const key = keySchema.safeParse(request.headers.get("Idempotency-Key"));
    if (!key.success) throw new ApiError(400, "idempotency_key_required");
    const requestHash = hash(stable(action));
    const previous = await p.store.rpc<Operation | null>("ads_operation_find", {
      p_user: a.user_id,
      p_account: a.id,
      p_key: key.data,
    });
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw new ApiError(409, "idempotency_conflict");
      return respond(previous);
    }
    const value = await plan(a, pol, action, p, false);
    if (Buffer.byteLength(JSON.stringify(value)) > 65536)
      throw new ApiError(413, "plan_too_large");
    const planHash = hash(
      stable({
        ...value,
        account_revision: a.revision,
        policy_revision: pol.revision,
      }),
    );
    try {
      return respond(
        await p.store.rpc("ads_operation_prepare", {
          p_user: a.user_id,
          p_account: a.id,
          p_key: key.data,
          p_request: requestHash,
          p_revision: a.revision,
          p_policy: pol.revision,
          p_hash: planHash,
          p_plan: value,
        }),
        201,
      );
    } catch (e) {
      failure(e);
    }
  });
export const validateAction = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      action = await jsonBody(request, actionInput);
    if (action.action === "video.upload")
      throw new ApiError(400, "video_validation_unavailable");
    return respond(await plan(a, await policy(a, p), action, p, true));
  });
export const getOperation = (
  id: string,
  operationId: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    if (!uuid.safeParse(operationId).success)
      throw new ApiError(404, "not_found");
    const result = await p.store.rpc<Operation | null>("ads_operation_get", {
      p_user: a.user_id,
      p_account: a.id,
      p_operation: operationId,
    });
    if (!result) throw new ApiError(404, "not_found");
    return respond(result);
  });
export const listOperations = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      q = new URL(request.url).searchParams;
    if (
      [...q.keys()].some((v) => v !== "cursor") ||
      q.getAll("cursor").length > 1 ||
      (q.has("cursor") && !uuid.safeParse(q.get("cursor")).success)
    )
      throw new ApiError(400, "invalid_query");
    return respond(
      await p.store.rpc("ads_operations", {
        p_user: a.user_id,
        p_account: a.id,
        p_before: q.get("cursor"),
      }),
    );
  });
export const executeAction = (
  id: string,
  operationId: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      body = await jsonBody(
        request,
        z
          .object({
            plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
            confirm_spend: z.boolean().default(false),
          })
          .strict(),
      );
    if (!uuid.safeParse(operationId).success)
      throw new ApiError(404, "not_found");
    let claimed: { claimed: boolean; operation: Operation };
    try {
      claimed = await p.store.rpc("ads_operation_begin", {
        p_user: a.user_id,
        p_account: a.id,
        p_operation: operationId,
        p_hash: body.plan_hash,
        p_confirm: body.confirm_spend,
      });
    } catch (e) {
      failure(e);
    }
    if (!claimed.claimed)
      return respond(
        claimed.operation,
        claimed.operation.state === "executing"
          ? 202
          : claimed.operation.state === "succeeded"
            ? 200
            : 409,
      );
    const o = claimed.operation;
    const finish = (state: string, result: unknown) =>
      p.store.rpc("ads_operation_finish", {
        p_user: a.user_id,
        p_account: a.id,
        p_operation: o.id,
        p_state: state,
        p_result: result,
      });
    try {
      const fresh = await account(a.user_id, id, p),
        pol = await policy(fresh, p);
      if (
        fresh.revision !== o.account_revision ||
        pol.revision !== o.policy_revision
      )
        throw new ApiError(409, "ads_connection_changed");
      const current = await plan(fresh, pol, o.plan.action, p, false);
      if (
        stable(current.dependencies) !== stable(o.plan.dependencies) ||
        stable(current.budget) !== stable(o.plan.budget)
      )
        throw new ApiError(409, "ads_plan_changed");
    } catch (e) {
      const code = e instanceof ApiError ? e.message : "preflight_failed";
      const result = await finish("cancelled", { error: code });
      return respond(result, e instanceof ApiError ? e.status : 503);
    }
    try {
      const result = await p.writer.mutate(
        a.ad_account_id,
        token(a, p),
        o.plan.action,
      );
      const value = {
        ...result,
        ads_manager_url: `https://adsmanager.facebook.com/adsmanager/manage/${o.plan.action.action.startsWith("adset") ? "adsets" : o.plan.action.action.startsWith("ad.") ? "ads" : "campaigns"}?act=${a.ad_account_id}`,
      };
      return respond(await finish("succeeded", value));
    } catch (e) {
      const uncertain = !(e instanceof WriteMetaError) || e.uncertain;
      const code =
        e instanceof ApiError ? e.message : "execution_result_unavailable";
      let value;
      try {
        value = await finish(uncertain ? "uncertain" : "failed", {
          error: code,
          ...(e instanceof WriteMetaError
            ? {
                provider_code: e.providerCode,
                provider_subcode: e.providerSubcode,
              }
            : {}),
        });
      } catch {
        throw new ApiError(503, "execution_result_unavailable");
      }
      return respond(
        value,
        uncertain ? 409 : e instanceof ApiError ? e.status : 503,
      );
    }
  });
export const listAssets = (
  id: string,
  kind: "pages" | "images" | "videos" | "instagram",
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      q = new URL(request.url).searchParams;
    if (
      [...q.keys()].some((v) => v !== "after") ||
      q.getAll("after").length > 1 ||
      (q.has("after") &&
        (!q.get("after") ||
          q.get("after")!.length > 2048 ||
          /[\r\n]/.test(q.get("after")!)))
    )
      throw new ApiError(400, "invalid_pagination");
    return respond(
      await p.writer.assets(
        a.ad_account_id,
        token(a, p),
        kind,
        q.get("after") ?? undefined,
      ),
    );
  });
