import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
import { metaId, type Collection } from "./queries";

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
const geo = z.object({
  countries: z.array(z.string().max(10)).max(250).optional(),
  regions: z
    .array(z.object({ key: text, name: text.optional() }))
    .max(500)
    .optional(),
  cities: z
    .array(
      z.object({
        key: text,
        name: text.optional(),
        radius: z.number().optional(),
        distance_unit: text.optional(),
      }),
    )
    .max(500)
    .optional(),
});
const namedIds = z
  .array(z.object({ id: metaId, name: text.optional() }))
  .max(500);
const targeting = z.object({
  geo_locations: geo.optional(),
  age_min: z.number().optional(),
  age_max: z.number().optional(),
  genders: z.array(z.number()).max(10).optional(),
  publisher_platforms: z.array(text).max(20).optional(),
  facebook_positions: z.array(text).max(50).optional(),
  instagram_positions: z.array(text).max(50).optional(),
  interests: namedIds.optional(),
  custom_audiences: namedIds.optional(),
  excluded_custom_audiences: namedIds.optional(),
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
  campaigns: z.object({ ...common, ...budget, objective: text.optional() }),
  adsets: z.object({
    ...common,
    ...budget,
    campaign_id: metaId,
    start_time: text.optional(),
    end_time: text.optional(),
    optimization_goal: text.optional(),
    billing_event: text.optional(),
    bid_strategy: text.optional(),
    targeting: targeting.optional(),
  }),
  ads: z.object({
    ...common,
    campaign_id: metaId,
    adset_id: metaId,
    creative: z
      .object({
        id: metaId,
        name: text.optional(),
        title: text.optional(),
        body: z.string().max(10000).optional(),
      })
      .optional(),
  }),
  instagram_accounts: z.object({ id: metaId, username: text }),
};
const actions = z
  .array(
    z.object({
      action_type: text,
      value: numeric.optional(),
      "1d_click": numeric.optional(),
      "7d_click": numeric.optional(),
      "1d_view": numeric.optional(),
      "7d_view": numeric.optional(),
    }),
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
  country: text.optional(),
  age: text.optional(),
  gender: text.optional(),
  publisher_platform: text.optional(),
  platform_position: text.optional(),
});
const COMMON =
  "id,account_id,name,status,effective_status,created_time,updated_time";
const fields: Record<Collection, string> = {
  campaigns: `${COMMON},objective,daily_budget,lifetime_budget,budget_remaining`,
  adsets: `${COMMON},campaign_id,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,optimization_goal,billing_event,bid_strategy,targeting{geo_locations,age_min,age_max,genders,publisher_platforms,facebook_positions,instagram_positions,interests,custom_audiences,excluded_custom_audiences}`,
  ads: `${COMMON},campaign_id,adset_id,creative{id,name,title,body}`,
  instagram_accounts: "id,username",
};
const INSIGHT_FIELDS =
  "account_id,account_name,account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,date_start,date_stop,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,action_values,video_play_actions";
export class AdsMetaError extends ApiError {
  constructor(
    code: string,
    public providerCode = 0,
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
  }
}
export interface AdsPage {
  data: Record<string, unknown>[];
  next_cursor: string | null;
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
  ) {
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
          signal: AbortSignal.timeout(12000),
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
      const err = data.error as { code?: number } | undefined,
        code = Number.isInteger(err?.code) ? err!.code! : 0;
      throw new AdsMetaError(
        res.status >= 500
          ? "meta_unavailable"
          : code === 190
            ? "ads_token_unavailable"
            : res.status === 429 ||
                [4, 17, 32, 613, 80000, 80004].includes(code)
              ? "meta_rate_limited"
              : [10, 200, 294].includes(code) || res.status === 403
                ? "ads_permission_required"
                : "meta_rejected",
        code,
      );
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
      (accountScoped && parsed.data.some((v) => v.account_id !== id))
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
      return page(
        await call(id, "insights", token, { ...query, fields: INSIGHT_FIELDS }),
        insightSchema,
        id,
      );
    },
  };
}
