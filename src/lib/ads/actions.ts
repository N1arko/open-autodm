import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
import { metaId } from "./queries";
import { resourceOptions, isResource, resourceParams } from "./resourceActions";

const name = z.string().trim().min(1).max(200);
export const money = z.string().regex(/^[1-9][0-9]{0,14}$/);
const url = z
  .string()
  .url()
  .max(2048)
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password;
  });
const timestamp = z.string().datetime({ offset: true });
const status = z.enum(["ACTIVE", "PAUSED"]);
const budget = {
  daily_budget: money.optional(),
  lifetime_budget: money.optional(),
};
const named = z.array(z.object({ id: metaId }).strict()).max(100);
export const targetingInput = z
  .object({
    geo_locations: z
      .object({
        countries: z
          .array(z.string().regex(/^[A-Z]{2}$/))
          .min(1)
          .max(100),
      })
      .strict(),
    age_min: z.number().int().min(18).max(65).optional(),
    age_max: z.number().int().min(18).max(65).optional(),
    genders: z
      .array(z.union([z.literal(1), z.literal(2)]))
      .min(1)
      .max(2)
      .optional(),
    publisher_platforms: z
      .array(z.enum(["facebook", "instagram", "messenger", "audience_network"]))
      .min(1)
      .max(4)
      .optional(),
    instagram_positions: z
      .array(
        z.enum([
          "stream",
          "story",
          "reels",
          "explore",
          "explore_home",
          "profile_feed",
          "ig_search",
        ]),
      )
      .min(1)
      .max(7)
      .optional(),
    facebook_positions: z
      .array(
        z.enum([
          "feed",
          "story",
          "facebook_reels",
          "instream_video",
          "marketplace",
          "search",
          "right_hand_column",
        ]),
      )
      .min(1)
      .max(7)
      .optional(),
    flexible_spec: z
      .array(
        z
          .object({ interests: named.optional(), behaviors: named.optional() })
          .strict(),
      )
      .min(1)
      .max(5)
      .optional(),
    custom_audiences: named.optional(),
    excluded_custom_audiences: named.optional(),
    locales: z.array(z.number().int().positive()).max(50).optional(),
    targeting_automation: z
      .object({ advantage_audience: z.union([z.literal(0), z.literal(1)]) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => (v.age_min ?? 18) <= (v.age_max ?? 65), "invalid_age_range");
const promoted = z
  .object({
    page_id: metaId.optional(),
    pixel_id: metaId.optional(),
    custom_event_type: z
      .enum([
        "PURCHASE",
        "LEAD",
        "COMPLETE_REGISTRATION",
        "ADD_TO_CART",
        "VIEW_CONTENT",
      ])
      .optional(),
    custom_conversion_id: metaId.optional(),
    instagram_user_id: metaId.optional(),
    application_id: metaId.optional(),
    object_store_url: url.optional(),
  })
  .strict();
const cta = z.enum([
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "LISTEN_NOW",
  "WATCH_MORE",
  "BOOK_NOW",
  "CONTACT_US",
  "DOWNLOAD",
  "GET_QUOTE",
  "MESSAGE_PAGE",
  "NO_BUTTON",
]);
const story = { page_id: metaId, instagram_user_id: metaId.optional() };
const creative = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("facebook_post"),
      object_story_id: z.string().regex(/^\d{1,30}_\d{1,30}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("instagram_post"),
      source_instagram_media_id: metaId,
      instagram_user_id: metaId,
      link: url.optional(),
      call_to_action: cta.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      ...story,
      image_hash: z
        .string()
        .regex(/^[a-f0-9]{32}$/i)
        .optional(),
      image_url: url.optional(),
      link: url,
      message: z.string().max(10000),
      title: name.optional(),
      call_to_action: cta.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("video"),
      ...story,
      video_id: metaId,
      image_url: url,
      link: url.optional(),
      message: z.string().max(10000),
      title: name.optional(),
      call_to_action: cta.optional(),
    })
    .strict(),
]);
const campaignFields = { name, ...budget };
const adsetFields = {
  name,
  ...budget,
  start_time: timestamp.optional(),
  end_time: timestamp.optional(),
  targeting: targetingInput,
  optimization_goal: z.enum([
    "LINK_CLICKS",
    "LANDING_PAGE_VIEWS",
    "REACH",
    "IMPRESSIONS",
    "THRUPLAY",
    "OFFSITE_CONVERSIONS",
    "VALUE",
    "LEAD_GENERATION",
    "QUALITY_LEAD",
    "CONVERSATIONS",
    "POST_ENGAGEMENT",
    "PROFILE_VISIT",
    "VISIT_INSTAGRAM_PROFILE",
    "APP_INSTALLS",
  ]),
  billing_event: z.enum(["IMPRESSIONS", "LINK_CLICKS", "THRUPLAY"]),
  bid_strategy: z
    .enum(["LOWEST_COST_WITHOUT_CAP", "COST_CAP", "LOWEST_COST_WITH_BID_CAP"])
    .optional(),
  bid_amount: money.optional(),
  promoted_object: promoted.optional(),
  destination_type: z
    .enum([
      "WEBSITE",
      "INSTAGRAM_PROFILE",
      "INSTAGRAM_DIRECT",
      "MESSENGER",
      "WHATSAPP",
      "APP",
      "ON_AD",
      "ON_POST",
      "ON_VIDEO",
    ])
    .optional(),
  dsa_beneficiary: name.optional(),
  dsa_payor: name.optional(),
};
const change = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .strict()
    .refine((v) => Object.keys(v).length > 0, "empty_update");
export const actionInput = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("campaign.create"),
        params: z
          .object({
            ...campaignFields,
            objective: z.enum([
              "OUTCOME_TRAFFIC",
              "OUTCOME_AWARENESS",
              "OUTCOME_ENGAGEMENT",
              "OUTCOME_LEADS",
              "OUTCOME_SALES",
              "OUTCOME_APP_PROMOTION",
            ]),
            special_ad_categories: z
              .array(
                z.enum([
                  "HOUSING",
                  "EMPLOYMENT",
                  "CREDIT",
                  "ISSUES_ELECTIONS_POLITICS",
                ]),
              )
              .max(4),
            special_ad_category_country: z
              .array(z.string().regex(/^[A-Z]{2}$/))
              .max(100)
              .optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("campaign.update"),
        object_id: metaId,
        params: change({ ...campaignFields, status }),
      })
      .strict(),
    z
      .object({
        action: z.literal("adset.create"),
        params: z.object({ ...adsetFields, campaign_id: metaId }).strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("adset.update"),
        object_id: metaId,
        params: change({ ...adsetFields, status }),
      })
      .strict(),
    z
      .object({
        action: z.literal("creative.create"),
        params: z.object({ name, creative }).strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("ad.create"),
        params: z
          .object({ name, adset_id: metaId, creative_id: metaId })
          .strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("ad.update"),
        object_id: metaId,
        params: change({ name, status, creative_id: metaId }),
      })
      .strict(),
    ...resourceOptions,
    z
      .object({
        action: z.literal("video.upload"),
        params: z.object({ name, file_url: url }).strict(),
      })
      .strict(),
  ])
  .superRefine((v, ctx) => {
    const p = v.params as Record<string, unknown>;
    if (isResource(v)) {
      if (
        v.action === "audience.users.add" &&
        v.params.payload.data.some(
          (row) => row.length !== v.params.payload.schema.length,
        )
      )
        ctx.addIssue({ code: "custom", message: "audience_columns_mismatch" });
      if (
        v.action.endsWith(".update") &&
        Object.keys(p).filter((k) => !["business_id", "catalog_id"].includes(k))
          .length === 0
      )
        ctx.addIssue({ code: "custom", message: "empty_update" });
      if (v.action === "audience.create") {
        if (p.subtype === "WEBSITE" && (!p.pixel_id || !p.rule))
          ctx.addIssue({
            code: "custom",
            message: "website_audience_requires_pixel_and_rule",
          });
        if (
          p.subtype === "LOOKALIKE" &&
          (!p.origin_audience_id || !p.lookalike_spec)
        )
          ctx.addIssue({
            code: "custom",
            message: "lookalike_requires_source_and_spec",
          });
        if (["ENGAGEMENT", "VIDEO"].includes(String(p.subtype)) && !p.rule)
          ctx.addIssue({ code: "custom", message: "engagement_requires_rule" });
        if (p.subtype === "CUSTOM" && !p.customer_file_source)
          ctx.addIssue({ code: "custom", message: "customer_source_required" });
      }
    }
    if (p.daily_budget && p.lifetime_budget)
      ctx.addIssue({ code: "custom", message: "choose_one_budget" });
    if (
      p.start_time &&
      p.end_time &&
      Date.parse(String(p.end_time)) <= Date.parse(String(p.start_time))
    )
      ctx.addIssue({ code: "custom", message: "invalid_schedule" });
    if (v.action === "adset.create" && p.lifetime_budget && !p.end_time)
      ctx.addIssue({
        code: "custom",
        message: "lifetime_budget_requires_end_time",
      });
    if (
      v.action === "creative.create" &&
      v.params.creative.kind === "instagram_post" &&
      v.params.creative.call_to_action &&
      !v.params.creative.link
    )
      ctx.addIssue({ code: "custom", message: "call_to_action_requires_link" });
    if (
      v.action === "creative.create" &&
      v.params.creative.kind === "image" &&
      !!v.params.creative.image_hash === !!v.params.creative.image_url
    )
      ctx.addIssue({ code: "custom", message: "choose_image_hash_or_url" });
  });
export type Action = z.infer<typeof actionInput>;
export const policyInput = z
  .object({
    enabled: z.boolean(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    max_daily_budget_minor: money.nullable(),
    max_lifetime_budget_minor: money.nullable(),
  })
  .strict();
export type Policy = z.infer<typeof policyInput> & { revision: number };
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function paramsFor(a: Action): Record<string, unknown> {
  if (isResource(a)) return resourceParams(a);
  const p = { ...a.params } as Record<string, unknown>;
  if (a.action.endsWith(".create") && a.action !== "creative.create")
    p.status = "PAUSED";
  if (a.action === "campaign.create") p.is_adset_budget_sharing_enabled = false;
  if (a.action === "ad.create" || a.action === "ad.update") {
    if (p.creative_id) {
      p.creative = { creative_id: p.creative_id };
      delete p.creative_id;
    }
  }
  if (a.action === "creative.create") {
    const c = (
      a.params as Extract<Action, { action: "creative.create" }>["params"]
    ).creative;
    delete p.creative;
    if (c.kind === "facebook_post") p.object_story_id = c.object_story_id;
    else if (c.kind === "instagram_post") {
      p.source_instagram_media_id = c.source_instagram_media_id;
      p.instagram_user_id = c.instagram_user_id;
      if (c.link) {
        p.link_url = c.link;
        p.call_to_action = {
          type: c.call_to_action ?? "LEARN_MORE",
          value: { link: c.link },
        };
      }
    } else {
      const callToAction = c.call_to_action
        ? {
            type: c.call_to_action,
            ...(c.link ? { value: { link: c.link } } : {}),
          }
        : undefined;
      p.object_story_spec = {
        page_id: c.page_id,
        ...(c.instagram_user_id
          ? { instagram_user_id: c.instagram_user_id }
          : {}),
        ...(c.kind === "image"
          ? {
              link_data: {
                ...(c.image_hash
                  ? { image_hash: c.image_hash }
                  : { picture: c.image_url }),
                link: c.link,
                message: c.message,
                ...(c.title ? { name: c.title } : {}),
                ...(callToAction ? { call_to_action: callToAction } : {}),
              },
            }
          : {
              video_data: {
                video_id: c.video_id,
                image_url: c.image_url,
                message: c.message,
                ...(c.title ? { title: c.title } : {}),
                ...(callToAction ? { call_to_action: callToAction } : {}),
              },
            }),
      };
    }
  }
  return p;
}
export const actionEdge: Partial<Record<Action["action"], string>> = {
  "campaign.create": "campaigns",
  "campaign.update": "",
  "adset.create": "adsets",
  "adset.update": "",
  "creative.create": "adcreatives",
  "ad.create": "ads",
  "ad.update": "",
  "video.upload": "advideos",
};
export function budgetWithin(daily: bigint, lifetime: bigint, policy: Policy) {
  if (
    daily > 0n &&
    (!policy.max_daily_budget_minor ||
      daily > BigInt(policy.max_daily_budget_minor))
  )
    throw new ApiError(409, "daily_budget_limit");
  if (
    lifetime > 0n &&
    (!policy.max_lifetime_budget_minor ||
      lifetime > BigInt(policy.max_lifetime_budget_minor))
  )
    throw new ApiError(409, "lifetime_budget_limit");
  if (daily === 0n && lifetime === 0n)
    throw new ApiError(409, "budget_required");
}
