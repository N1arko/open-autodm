import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
import { metaId, type Collection } from "./queries";
import { isRateLimit, retryAfter } from "./rateLimit";
import { creativeRead, CREATIVE_FIELDS, providerJson } from "./readback";
import {
  extendedInsightFields,
  instagramInsightFields,
  rowReport,
} from "./report";

const text = z.string().max(1000);
const numeric = z.union([
  z
    .string()
    .max(100)
    .regex(/^-?\d+(\.\d+)?$/),
  z.number().finite(),
]);
const metadataSchema = z.object({
  id: z.string().regex(/^act_\d{1,30}$/),
  account_id: metaId,
  name: text,
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone_name: z.string().max(100),
  account_status: z.number().int(),
  amount_spent: numeric.optional(),
  spend_cap: numeric.optional(),
  disable_reason: z.number().int().optional(),
});
export type AdsMetadata = z.infer<typeof metadataSchema>;
const namedIds = z
  .array(z.object({ id: metaId, name: text.optional() }))
  .max(500);
const targeting = z.object({
  geo_locations: providerJson.optional(),
  excluded_geo_locations: providerJson.optional(),
  age_min: z.number().optional(),
  age_max: z.number().optional(),
  genders: z.array(z.number()).max(10).optional(),
  publisher_platforms: z.array(text).max(20).optional(),
  facebook_positions: z.array(text).max(50).optional(),
  instagram_positions: z.array(text).max(50).optional(),
  interests: namedIds.optional(),
  custom_audiences: namedIds.optional(),
  excluded_custom_audiences: namedIds.optional(),
  flexible_spec: providerJson.optional(),
  targeting_automation: providerJson.optional(),
  device_platforms: z.array(text).max(20).optional(),
  user_os: z.array(text).max(100).optional(),
  user_device: z.array(text).max(100).optional(),
  locales: z.array(z.number()).max(100).optional(),
});
const common = {
  id: metaId,
  account_id: metaId,
  name: text,
  status: text,
  effective_status: text.optional(),
  created_time: text.optional(),
  updated_time: text.optional(),
};
const budget = {
  daily_budget: numeric.optional(),
  lifetime_budget: numeric.optional(),
  budget_remaining: numeric.optional(),
};
const schemas = {
  campaigns: z.object({
    ...common,
    ...budget,
    objective: text.optional(),
    bid_strategy: text.optional(),
    spend_cap: numeric.optional(),
    issues_info: providerJson.optional(),
  }),
  adsets: z.object({
    ...common,
    ...budget,
    campaign_id: metaId,
    start_time: text.optional(),
    end_time: text.optional(),
    optimization_goal: text.optional(),
    billing_event: text.optional(),
    bid_strategy: text.optional(),
    bid_amount: numeric.optional(),
    bid_constraints: providerJson.optional(),
    destination_type: text.optional(),
    promoted_object: providerJson.optional(),
    placement_soft_opt_out: providerJson.optional(),
    attribution_spec: providerJson.optional(),
    learning_stage_info: providerJson.optional(),
    issues_info: providerJson.optional(),
    targeting: targeting.optional(),
  }),
  ads: z.object({
    ...common,
    campaign_id: metaId,
    adset_id: metaId,
    creative: creativeRead.optional(),
    issues_info: providerJson.optional(),
    ad_review_feedback: providerJson.optional(),
  }),
  instagram_accounts: z.object({ id: metaId, username: text }),
};
const actions = z
  .array(
    z
      .object({
        action_type: text,
        value: numeric.optional(),
        "1d_click": numeric.optional(),
        "7d_click": numeric.optional(),
        "1d_view": numeric.optional(),
        "7d_view": numeric.optional(),
      })
      .passthrough()
      .transform((v) => providerJson.parse(v) as typeof v),
  )
  .max(500);
const insightSchema = z.object({
  account_id: metaId,
  account_name: text.optional(),
  account_currency: z.string().max(10).optional(),
  campaign_id: metaId.optional(),
  campaign_name: text.optional(),
  adset_id: metaId.optional(),
  adset_name: text.optional(),
  ad_id: metaId.optional(),
  ad_name: text.optional(),
  date_start: text,
  date_stop: text,
  spend: numeric.optional(),
  impressions: numeric.optional(),
  reach: numeric.optional(),
  clicks: numeric.optional(),
  ctr: numeric.optional(),
  cpc: numeric.optional(),
  cpm: numeric.optional(),
  frequency: numeric.optional(),
  actions: actions.optional(),
  action_values: actions.optional(),
  video_play_actions: actions.optional(),
  instagram_profile_follow: numeric.nullable().optional(),
  instagram_profile_visits: numeric.nullable().optional(),
  inline_link_clicks: numeric.optional(),
  inline_link_click_ctr: numeric.optional(),
  cost_per_inline_link_click: numeric.optional(),
  outbound_clicks: actions.optional(),
  outbound_clicks_ctr: actions.optional(),
  cost_per_outbound_click: actions.optional(),
  cost_per_action_type: actions.optional(),
  unique_actions: actions.optional(),
  attribution_setting: text.optional(),
  video_thruplay_watched_actions: actions.optional(),
  video_p25_watched_actions: actions.optional(),
  video_p50_watched_actions: actions.optional(),
  video_p75_watched_actions: actions.optional(),
  video_p100_watched_actions: actions.optional(),
  video_avg_time_watched_actions: actions.optional(),
  country: text.optional(),
  age: text.optional(),
  gender: text.optional(),
  publisher_platform: text.optional(),
  platform_position: text.optional(),
});
const COMMON =
  "id,account_id,name,status,effective_status,created_time,updated_time";
const fields: Record<Collection, string> = {
  campaigns: `${COMMON},objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,spend_cap,issues_info`,
  adsets: `${COMMON},campaign_id,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,optimization_goal,billing_event,bid_strategy,bid_amount,bid_constraints,destination_type,promoted_object,placement_soft_opt_out,attribution_spec,learning_stage_info,issues_info,targeting`,
  ads: `${COMMON},campaign_id,adset_id,issues_info,ad_review_feedback,creative{${CREATIVE_FIELDS}}`,
  instagram_accounts: "id,username",
};
const INSIGHT_FIELDS =
  "account_id,account_name,account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,date_start,date_stop,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,action_values,video_play_actions";
export class AdsMetaError extends ApiError {
  invalidInsightField?: string;
  constructor(
    code: string,
    public providerCode = 0,
    retry?: ReturnType<typeof retryAfter>,
  ) {
    super(
      code === "ads_permission_required"
        ? 403
        : code === "ads_token_unavailable"
          ? 409
          : code === "meta_rate_limited"
            ? 429
            : 502,
      code,
    );
    if (retry) {
      this.retryAfterSeconds = retry.seconds;
      this.retrySource = retry.source;
      this.retryScope = "read";
    }
  }
}
export interface AdsPage {
  data: Record<string, unknown>[];
  next_cursor: string | null;
  requested_fields?: string[];
  unsupported_fields?: string[];
  provider_fields?: string[];
}
export interface AdsMeta {
  profile(id: string, token: string): Promise<AdsMetadata>;
  list(
    id: string,
    token: string,
    collection: Collection,
    query: Record<string, string>,
  ): Promise<AdsPage>;
  insights(
    id: string,
    token: string,
    query: Record<string, string>,
  ): Promise<AdsPage>;
}
/** The only production host is graph.facebook.com; every upstream operation is GET. */
export function adsMeta(
  fetcher: typeof fetch = fetch,
  base = "https://graph.facebook.com/v26.0",
): AdsMeta {
  async function call(
    id: string,
    edge: string,
    token: string,
    params: Record<string, string>,
    attempt = 0,
    deadline = Date.now() + 12000,
  ) {
    if (Date.now() >= deadline) throw new AdsMetaError("meta_unavailable");
    if (!metaId.safeParse(id).success)
      throw new ApiError(400, "invalid_ad_account_id");
    let res: Response, data: Record<string, unknown>;
    try {
      res = await fetcher(
        `${base}/act_${id}${edge ? `/${edge}` : ""}?${new URLSearchParams(params)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(12000, deadline - Date.now())),
        },
      );
      const reader = res.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
    } catch {
      throw new AdsMetaError("meta_unavailable");
    }
    if (!res.ok || data.error) {
      const err = data.error as { code?: number; message?: string } | undefined,
        code = Number.isInteger(err?.code) ? err!.code! : 0;
      const limited = isRateLimit(res.status, code),
        retry = limited ? retryAfter(res.headers) : undefined;
      if (retry && retry.seconds <= 1 && attempt === 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, retry.seconds * 1000),
        );
        return call(id, edge, token, params, attempt + 1, deadline);
      }
      const error = new AdsMetaError(
        limited
          ? "meta_rate_limited"
          : res.status >= 500
            ? "meta_unavailable"
            : code === 190
              ? "ads_token_unavailable"
              : isRateLimit(res.status, code)
                ? "meta_rate_limited"
                : [10, 200, 294].includes(code) || res.status === 403
                  ? "ads_permission_required"
                  : "meta_rejected",
        code,
        retry,
      );
      if (
        edge === "insights" &&
        res.status === 400 &&
        code === 100 &&
        typeof err?.message === "string"
      ) {
        error.invalidInsightField = instagramInsightFields.find((field) =>
          new RegExp(
            `['\"]?${field}['\"]? is not valid for fields param\\b`,
          ).test(err.message!),
        );
      }
      throw error;
    }
    return data;
  }
  function page(
    data: Record<string, unknown>,
    schema: z.ZodTypeAny,
    id: string,
    accountScoped = true,
  ): AdsPage {
    const parsed = z.array(schema).max(50).safeParse(data.data);
    if (
      !parsed.success ||
      (accountScoped &&
        parsed.data.some(
          (v) =>
            v.account_id !== id ||
            (v.creative?.account_id && v.creative.account_id !== id),
        ))
    )
      throw new AdsMetaError("meta_invalid_response");
    const paging = data.paging as
      | { next?: unknown; cursors?: { after?: unknown } }
      | undefined;
    const after = paging?.cursors?.after;
    if (
      paging?.next &&
      (typeof after !== "string" ||
        !after ||
        after.length > 2048 ||
        /[\r\n]/.test(after))
    )
      throw new AdsMetaError("meta_invalid_response");
    // Never follow Meta's next URL (which can contain a token); rebuild a fixed-host request.
    return {
      data: parsed.data,
      next_cursor: paging?.next ? (after as string) : null,
    };
  }
  return {
    async profile(id, token) {
      const result = metadataSchema.safeParse(
        await call(id, "", token, {
          fields:
            "id,account_id,name,currency,timezone_name,account_status,amount_spent,spend_cap,disable_reason",
        }),
      );
      if (
        !result.success ||
        result.data.account_id !== id ||
        result.data.id !== `act_${id}`
      )
        throw new AdsMetaError("meta_invalid_response");
      // Fail closed if the provider's timezone cannot be interpreted.
      try {
        new Intl.DateTimeFormat("en", { timeZone: result.data.timezone_name });
      } catch {
        throw new AdsMetaError("meta_invalid_timezone");
      }
      return result.data;
    },
    async list(id, token, collection, query) {
      return page(
        await call(id, collection, token, {
          ...query,
          fields: fields[collection],
        }),
        schemas[collection],
        id,
        collection !== "instagram_accounts",
      );
    },
    async insights(id, token, query) {
      const requested = [
        ...INSIGHT_FIELDS.split(","),
        ...extendedInsightFields,
      ];
      const unsupported: string[] = [],
        deadline = Date.now() + 30000;
      for (;;) {
        try {
          const result = page(
            await call(
              id,
              "insights",
              token,
              {
                ...query,
                fields: requested
                  .filter((f) => !unsupported.includes(f))
                  .join(","),
              },
              0,
              deadline,
            ),
            insightSchema,
            id,
          );
          return {
            ...result,
            data: result.data.map((row) => ({
              ...row,
              report: rowReport(row, unsupported),
            })),
            requested_fields: requested,
            unsupported_fields: unsupported,
            provider_fields: requested.filter((f) => !unsupported.includes(f)),
          };
        } catch (e) {
          if (
            !(e instanceof AdsMetaError) ||
            !e.invalidInsightField ||
            unsupported.includes(e.invalidInsightField) ||
            unsupported.length >= instagramInsightFields.length
          )
            throw e;
          unsupported.push(e.invalidInsightField);
        }
      }
    },
  };
}
