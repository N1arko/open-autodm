import { z } from "zod";
import {
  ApiError,
  apiRoute,
  jsonBody,
  owner,
  respond,
} from "@/lib/transport/api";
import { account, token, type AdsAccount } from "./service";
import {
  defaultManagePorts,
  prepareManaged,
  executeManaged,
  type ManagePorts,
} from "./manage";
import { actionInput, money, type Action } from "./actions";
import { metaId, localDay, date } from "./queries";
import { writeMeta } from "./writeMeta";
import type { TransportStore } from "@/lib/transport/store";

export const ruleInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(false),
    mode: z.enum(["observe", "execute"]).default("observe"),
    level: z.enum(["campaign", "adset", "ad"]),
    object_ids: z
      .array(metaId)
      .min(1)
      .max(25)
      .refine((v) => new Set(v).size === v.length),
    window_days: z.number().int().min(1).max(30),
    interval_seconds: z.number().int().min(3600).max(86400).default(3600),
    cooldown_seconds: z.number().int().min(86400).max(2592000).default(86400),
    max_changes_per_day: z.number().int().min(1).max(25).default(1),
    min_spend_minor: z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
    min_impressions: z.number().int().min(1).max(1000000000),
    min_results: z.number().int().min(0).max(1000000000).default(0),
    condition: z
      .object({
        metric: z.enum([
          "spend_minor",
          "cpa_minor",
          "roas",
          "ctr",
          "cpc_minor",
          "frequency",
          "clicks",
          "impressions",
        ]),
        operator: z.enum(["gt", "gte", "lt", "lte"]),
        threshold: z.number().finite().min(0).max(1e15),
        action_type: z.string().min(1).max(200).optional(),
      })
      .strict(),
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pause") }).strict(),
      z
        .object({
          kind: z.literal("adjust_daily_budget"),
          percent: z
            .number()
            .int()
            .min(-50)
            .max(20)
            .refine((v) => v !== 0),
          min_budget_minor: money,
          max_budget_minor: money,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      ["cpa_minor", "roas"].includes(v.condition.metric) &&
      !v.condition.action_type
    )
      ctx.addIssue({ code: "custom", message: "action_type_required" });
    if (
      v.action.kind === "adjust_daily_budget" &&
      (v.level === "ad" ||
        BigInt(v.action.min_budget_minor) > BigInt(v.action.max_budget_minor))
    )
      ctx.addIssue({ code: "custom", message: "invalid_budget_rule" });
  });
export type RuleConfig = z.infer<typeof ruleInput>;
export type Rule = {
  id: string;
  account_id: string;
  owner_id: string;
  config: RuleConfig;
  revision: number;
  claim_token: string;
};
const uuid = z.string().uuid();
const input = z
  .object({ config: ruleInput, authorize_changes: z.boolean().default(false) })
  .strict();
function pagination(request: Request) {
  const q = new URL(request.url).searchParams;
  if (
    [...q.keys()].some((k) => k !== "cursor") ||
    q.getAll("cursor").length > 1 ||
    (q.has("cursor") && !uuid.safeParse(q.get("cursor")).success)
  )
    throw new ApiError(400, "invalid_query");
  return q.get("cursor");
}
export const listRules = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    return respond(
      await p.store.rpc("ads_rules", {
        p_user: a.user_id,
        p_account: a.id,
        p_before: pagination(request),
      }),
    );
  });
export const setRule = (
  id: string,
  ruleId: string | null,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      value = await jsonBody(request, input);
    token(a, p);
    if (ruleId && !uuid.safeParse(ruleId).success)
      throw new ApiError(404, "not_found");
    if (
      value.config.enabled &&
      value.config.mode === "execute" &&
      !value.authorize_changes
    )
      throw new ApiError(409, "automation_authorization_required");
    if (
      value.config.enabled &&
      value.config.mode === "execute" &&
      value.config.action.kind === "adjust_daily_budget"
    ) {
      const pol = await p.store.rpc<{
        enabled: boolean;
        max_daily_budget_minor: string | null;
      } | null>("ads_policy", { p_user: a.user_id, p_account: a.id });
      if (!pol?.enabled) throw new ApiError(409, "ads_management_disabled");
      if (
        !pol.max_daily_budget_minor ||
        BigInt(value.config.action.max_budget_minor) >
          BigInt(pol.max_daily_budget_minor)
      )
        throw new ApiError(409, "daily_budget_limit");
    }
    for (const objectId of value.config.object_ids)
      await p.writer.object(
        a.ad_account_id,
        objectId,
        value.config.level,
        token(a, p),
      );
    try {
      return respond(
        await p.store.rpc("ads_rule_set", {
          p_user: a.user_id,
          p_account: a.id,
          p_rule: ruleId,
          p_config: value.config,
          p_authorized: value.authorize_changes,
        }),
        ruleId ? 200 : 201,
      );
    } catch (e) {
      if (
        e instanceof Error &&
        [
          "ads_management_disabled",
          "operation_in_progress",
          "rule_limit",
          "automation_authorization_required",
        ].includes(e.message)
      )
        throw new ApiError(409, e.message);
      throw e;
    }
  });
export const listRuleRuns = (
  id: string,
  ruleId: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    if (!uuid.safeParse(ruleId).success) throw new ApiError(404, "not_found");
    return respond(
      await p.store.rpc("ads_rule_runs", {
        p_user: a.user_id,
        p_account: a.id,
        p_rule: ruleId,
        p_before: pagination(request),
      }),
    );
  });
export function minor(value: unknown, currency: string): number | null {
  const s = String(value ?? ""),
    m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const digits =
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  if (m[2] && m[2].slice(digits).replace(/0/g, "")) return null;
  const n = Number(m[1]! + (m[2] ?? "").slice(0, digits).padEnd(digits, "0"));
  return Number.isSafeInteger(n) ? n : null;
}
export function evaluate(
  config: RuleConfig,
  row: Record<string, unknown>,
  currency: string,
) {
  const numeric = (v: unknown) =>
    v !== null &&
    v !== undefined &&
    /^(\d+)(\.\d+)?$/.test(String(v)) &&
    Number.isFinite(Number(v))
      ? Number(v)
      : null;
  const spend = minor(row.spend, currency),
    impressions = numeric(row.impressions);
  const actions = Array.isArray(row.actions)
    ? (row.actions as { action_type: string; value?: unknown }[])
    : [];
  const values = Array.isArray(row.action_values)
    ? (row.action_values as { action_type: string; value?: unknown }[])
    : [];
  const results =
    numeric(
      actions.find((r) => r.action_type === config.condition.action_type)
        ?.value,
    ) ?? 0;
  let metric: number | null = null;
  switch (config.condition.metric) {
    case "spend_minor":
      metric = spend;
      break;
    case "cpa_minor":
      metric = spend !== null && results > 0 ? spend / results : null;
      break;
    case "roas": {
      const revenue = minor(
        values.find((r) => r.action_type === config.condition.action_type)
          ?.value,
        currency,
      );
      metric =
        spend !== null && spend > 0 && revenue !== null
          ? revenue / spend
          : null;
      break;
    }
    case "cpc_minor": {
      const n = numeric(row.cpc);
      metric =
        n === null
          ? null
          : n *
            10 **
              (new Intl.NumberFormat("en", {
                style: "currency",
                currency,
              }).resolvedOptions().maximumFractionDigits ?? 2);
      break;
    }
    default:
      metric = numeric(row[config.condition.metric]);
  }
  const enough =
    spend !== null &&
    impressions !== null &&
    spend >= Number(config.min_spend_minor) &&
    impressions >= config.min_impressions &&
    results >= config.min_results;
  const t = config.condition.threshold,
    op = config.condition.operator;
  const matched =
    enough &&
    metric !== null &&
    (op === "gt"
      ? metric > t
      : op === "gte"
        ? metric >= t
        : op === "lt"
          ? metric < t
          : metric <= t);
  return {
    matched,
    metric,
    spend_minor: spend,
    impressions,
    results,
    sufficient_data: enough,
  };
}
export function optimizationAction(
  config: RuleConfig,
  object: {
    id: string;
    name?: string;
    status?: string;
    daily_budget?: string;
    lifetime_budget?: string;
  },
): Action | null {
  // Rules never activate ads; a new paused object remains paused.
  if (object.status !== "ACTIVE") return null;
  if (config.action.kind === "pause")
    return actionInput.parse({
      action: `${config.level}.update`,
      object_id: object.id,
      params: { status: "PAUSED" },
    });
  if (
    !object.daily_budget ||
    BigInt(object.daily_budget) === 0n ||
    BigInt(object.lifetime_budget ?? "0") > 0n
  )
    throw new ApiError(409, "daily_budget_rule_requires_daily_budget");
  const b = config.action,
    current = BigInt(object.daily_budget),
    changed = (current * BigInt(100 + b.percent)) / 100n;
  const bounded =
    changed < BigInt(b.min_budget_minor)
      ? BigInt(b.min_budget_minor)
      : changed > BigInt(b.max_budget_minor)
        ? BigInt(b.max_budget_minor)
        : changed;
  // Reaching a bound must never reverse the requested adjustment's direction.
  if (
    bounded === current ||
    (b.percent > 0 && bounded < current) ||
    (b.percent < 0 && bounded > current)
  )
    return null;
  return actionInput.parse({
    action: `${config.level}.update`,
    object_id: object.id,
    params: { daily_budget: bounded.toString() },
  });
}
async function rows(a: AdsAccount, config: RuleConfig, p: ManagePorts) {
  const today = date(localDay(a.metadata.timezone_name));
  const day = (v: number) => new Date(v).toISOString().slice(0, 10);
  const query = {
    level: config.level,
    limit: "50",
    time_increment: "all_days",
    time_range: JSON.stringify({
      since: day(today - config.window_days * 86400000),
      until: day(today - 86400000),
    }),
    use_unified_attribution_setting: "true",
    action_report_time: "conversion",
  };
  const found = new Map<string, Record<string, unknown>>();
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await p.meta.insights(a.ad_account_id, token(a, p), {
      ...query,
      ...(after ? { after } : {}),
    });
    for (const row of result.data) {
      const id = String(row[`${config.level}_id`] ?? "");
      if (config.object_ids.includes(id)) {
        if (found.has(id)) throw new ApiError(502, "duplicate_insight_row");
        if (
          row.account_currency &&
          row.account_currency !== a.metadata.currency
        )
          throw new ApiError(409, "currency_changed");
        found.set(id, row);
      }
    }
    if (!result.next_cursor) return { found, query };
    if (result.next_cursor === after)
      throw new ApiError(502, "meta_invalid_response");
    after = result.next_cursor;
  }
  throw new ApiError(409, "optimization_inventory_too_large");
}
const defaultOptimizationPorts = (): ManagePorts => ({
  ...defaultManagePorts(),
  writer: writeMeta(
    fetch,
    "https://graph.facebook.com/v26.0",
    Date.now() + 240000,
  ),
});
export async function drainOptimization(
  store: TransportStore,
  ports = defaultOptimizationPorts,
  limit = 2,
) {
  const claims = await store.rpc<Rule[]>("ads_rule_claim", { p_limit: limit });
  // Sequential per process, DB leases and operation locks coordinate other processes.
  for (const claim of claims) {
    const p = { ...ports(), store };
    let error: string | null = null;
    const active = async () => {
      const rule = await store.rpc<Rule | null>("ads_rule_context", {
        p_rule: claim.id,
        p_claim: claim.claim_token,
      });
      if (!rule) throw new ApiError(409, "automation_cancelled");
      return { rule, a: await account(rule.owner_id, rule.account_id, p) };
    };
    try {
      const { a, rule } = await active(),
        config = ruleInput.parse(rule.config),
        collected = await rows(a, config, p);
      for (const objectId of config.object_ids) {
        const fresh = await active(),
          row = collected.found.get(objectId),
          evidence = row
            ? {
                ...evaluate(config, row, a.metadata.currency),
                query: collected.query,
                currency: a.metadata.currency,
              }
            : {
                matched: false,
                reason: "no_insight_data",
                query: collected.query,
              };
        let action: Action | null = null;
        if (evidence.matched)
          action = optimizationAction(
            config,
            await p.writer.object(
              fresh.a.ad_account_id,
              objectId,
              config.level,
              token(fresh.a, p),
            ),
          );
        const outcome = action
          ? config.mode === "observe"
            ? "suggested"
            : "reserved"
          : evidence.matched
            ? "no_change"
            : "not_matched";
        const operation =
          action && config.mode === "execute"
            ? await prepareManaged(
                fresh.a,
                action,
                `opt:${claim.id}:${claim.claim_token}:${objectId}`,
                p,
              )
            : null;
        const recorded = await store.rpc("ads_rule_record", {
          p_rule: claim.id,
          p_claim: claim.claim_token,
          p_object: objectId,
          p_mode: config.mode,
          p_outcome: outcome,
          p_evidence: { ...evidence, action },
          p_operation: operation?.id ?? null,
        });
        if (operation && recorded) {
          await active();
          const response = await executeManaged(
            fresh.a,
            operation.id,
            operation.plan_hash,
            true,
            p,
          );
          const result = (await response.json()) as {
            state?: string;
            error?: string;
          };
          await store.rpc("ads_rule_result", {
            p_rule: claim.id,
            p_claim: claim.claim_token,
            p_object: objectId,
            p_outcome: result.state ?? "failed",
          });
          if (result.state === "uncertain" || result.state === "executing")
            throw new ApiError(409, "automation_execution_uncertain");
          if (!response.ok || result.state !== "succeeded")
            throw new ApiError(409, "automation_action_failed");
        }
      }
    } catch (e) {
      error = e instanceof ApiError ? e.message : "optimization_unavailable";
    }
    await store.rpc("ads_rule_finish", {
      p_rule: claim.id,
      p_claim: claim.claim_token,
      p_error: error,
    });
  }
  return claims.length;
}
