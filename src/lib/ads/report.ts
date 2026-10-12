import { localDay } from "./queries";

export const extendedInsightFields = [
  "instagram_profile_follow",
  "instagram_profile_visits",
  "inline_link_clicks",
  "inline_link_click_ctr",
  "cost_per_inline_link_click",
  "outbound_clicks",
  "outbound_clicks_ctr",
  "cost_per_outbound_click",
  "cost_per_action_type",
  "unique_actions",
  "attribution_setting",
  "video_thruplay_watched_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p100_watched_actions",
  "video_avg_time_watched_actions",
] as const;
export const instagramInsightFields = [
  "instagram_profile_follow",
  "instagram_profile_visits",
] as const;
type Source = {
  field: string;
  action_type?: string;
  definition?: string;
  ui_mapping?: string;
  unit?: "currency_major" | "percent" | "ratio";
};
export const metricSources: Record<string, Source> = {
  spend: { field: "spend", unit: "currency_major" },
  impressions: { field: "impressions" },
  reach: { field: "reach" },
  clicks_all: { field: "clicks" },
  ctr_all: { field: "ctr", unit: "percent" },
  cpc_all: { field: "cpc", unit: "currency_major" },
  cpm: { field: "cpm", unit: "currency_major" },
  frequency: { field: "frequency", unit: "ratio" },
  inline_link_ctr: { field: "inline_link_click_ctr", unit: "percent" },
  instagram_follows: {
    field: "instagram_profile_follow",
    definition: "ad_attributed_profile_follows",
  },
  instagram_profile_visits: { field: "instagram_profile_visits" },
  link_clicks: { field: "actions", action_type: "link_click" },
  inline_link_clicks: {
    field: "inline_link_clicks",
    definition: "provider_inline_link_clicks",
  },
  outbound_clicks: { field: "outbound_clicks", action_type: "outbound_click" },
  reactions: { field: "actions", action_type: "post_reaction" },
  saves: { field: "actions", action_type: "onsite_conversion.post_save" },
  comments: { field: "actions", action_type: "comment" },
  shares: { field: "actions", action_type: "post" },
  post_engagement: { field: "actions", action_type: "post_engagement" },
  landing_page_views: { field: "actions", action_type: "landing_page_view" },
  messaging_conversations_started: {
    field: "actions",
    action_type: "onsite_conversion.messaging_conversation_started_7d",
    ui_mapping: "requires_account_verification",
  },
  messaging_conversations_replied: {
    field: "actions",
    action_type: "onsite_conversion.messaging_conversation_replied_7d",
    ui_mapping: "requires_account_verification",
  },
  messaging_first_replies: {
    field: "actions",
    action_type: "onsite_conversion.messaging_first_reply",
    ui_mapping: "new_contacts_mapping_requires_verification",
  },
  messaging_welcome_views: {
    field: "actions",
    action_type: "onsite_conversion.messaging_welcome_message_view",
    ui_mapping: "requires_account_verification",
  },
  messaging_subscriptions: {
    field: "actions",
    action_type: "onsite_conversion.messaging_subscribe",
    ui_mapping: "requires_account_verification",
    definition: "messaging_action_not_instagram_profile_follow",
  },
  video_plays: { field: "video_play_actions", action_type: "video_view" },
  video_thruplays: {
    field: "video_thruplay_watched_actions",
    action_type: "video_view",
  },
  video_25_percent: {
    field: "video_p25_watched_actions",
    action_type: "video_view",
  },
  video_50_percent: {
    field: "video_p50_watched_actions",
    action_type: "video_view",
  },
  video_75_percent: {
    field: "video_p75_watched_actions",
    action_type: "video_view",
  },
  video_100_percent: {
    field: "video_p100_watched_actions",
    action_type: "video_view",
  },
};
export type MetricStatus =
  | "available"
  | "not_returned"
  | "unsupported"
  | "unavailable";
interface Measure {
  value: string | null;
  status: MetricStatus;
  source: Source;
  reason?: string;
}
function decimal(value: unknown): string | null {
  return (typeof value === "string" &&
    /^-?\d+(\.\d+)?$/.test(value) &&
    value.length <= 100) ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      /^-?\d+(\.\d+)?$/.test(String(value)))
    ? String(value)
    : null;
}
function measure(
  row: Record<string, unknown>,
  source: Source,
  unsupported: string[],
): Measure {
  if (unsupported.includes(source.field))
    return {
      value: null,
      status: "unsupported",
      source,
      reason: "provider_invalid_field",
    };
  let value = row[source.field];
  if (source.action_type) {
    const items = Array.isArray(value)
      ? value.filter((v) => v?.action_type === source.action_type)
      : [];
    if (items.length > 1)
      return {
        value: null,
        status: "unavailable",
        source,
        reason: "ambiguous_action_rows",
      };
    value = items[0]?.value;
  }
  const parsed = decimal(value);
  return parsed !== null
    ? { value: parsed, status: "available", source }
    : {
        value: null,
        status:
          value !== undefined && value !== null
            ? "unavailable"
            : "not_returned",
        source,
        reason:
          value === null
            ? "provider_null"
            : value === undefined
              ? "provider_omitted"
              : "numeric_representation_unavailable",
      };
}
/** Exact decimal arithmetic in major currency units; six decimals, half-up rounding. */
export function costRatio(spend: string, count: string): string | null {
  if (
    !/^\d+(\.\d+)?$/.test(spend) ||
    !/^\d+(\.\d+)?$/.test(count) ||
    spend.length > 100 ||
    count.length > 100
  )
    return null;
  const parts = (s: string) => {
    const [a, b = ""] = s.split(".");
    return { n: BigInt(a! + b), scale: 10n ** BigInt(b.length) };
  };
  const a = parts(spend),
    b = parts(count);
  if (b.n === 0n) return null;
  const numerator = a.n * b.scale * 1000000n,
    denominator = b.n * a.scale;
  const rounded = (numerator + denominator / 2n) / denominator;
  return `${rounded / 1000000n}.${String(rounded % 1000000n).padStart(6, "0")}`;
}
export function rowReport(
  row: Record<string, unknown>,
  unsupported: string[] = [],
) {
  const metrics = Object.fromEntries(
    Object.entries(metricSources).map(([name, source]) => [
      name,
      measure(row, source, unsupported),
    ]),
  );
  const costs: Record<
    string,
    Measure & { formula?: string; precision?: number }
  > = {};
  for (const [name, count] of Object.entries(metrics)) {
    if (
      count.source.unit ||
      ["impressions", "reach", "clicks_all"].includes(name)
    )
      continue;
    const nativeSource =
      count.source.field === "actions"
        ? {
            field: "cost_per_action_type",
            action_type: count.source.action_type,
          }
        : name === "inline_link_clicks"
          ? { field: "cost_per_inline_link_click" }
          : name === "outbound_clicks"
            ? {
                field: "cost_per_outbound_click",
                action_type: "outbound_click",
              }
            : null;
    const native = nativeSource
      ? measure(row, nativeSource, unsupported)
      : null;
    if (native?.status === "available") {
      costs[name] = native;
      continue;
    }
    const value =
      metrics.spend!.value !== null && count.value !== null
        ? costRatio(metrics.spend!.value, count.value)
        : null;
    costs[name] = {
      value,
      status:
        value === null
          ? count.status === "available"
            ? "unavailable"
            : count.status
          : "available",
      source: { field: "derived" },
      formula: `spend / ${name}`,
      precision: 6,
      ...(value === null
        ? {
            reason:
              count.value !== null && /^0+(\.0+)?$/.test(count.value)
                ? "zero_denominator"
                : "inputs_unavailable_or_nonpositive",
          }
        : {}),
    };
  }
  return {
    metrics,
    cost_per_result: costs,
    attribution_setting: row.attribution_setting ?? null,
    messaging_actions: Array.isArray(row.actions)
      ? row.actions.filter(
          (v) =>
            typeof v?.action_type === "string" &&
            /messag|contact|subscribe/.test(v.action_type),
        )
      : [],
    new_messaging_contacts: {
      value: null,
      status: "unavailable",
      reason: "ui_mapping_not_verified",
      candidate_action_type: "onsite_conversion.messaging_first_reply",
    },
  };
}
export function reporting(
  query: Record<string, string>,
  timezone: string,
  observedAt: string,
) {
  const { since, until } = JSON.parse(query.time_range!);
  const to = new Date(Date.parse(`${until}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const today = localDay(timezone, Date.parse(observedAt));
  return {
    observed_at: observedAt,
    from: since,
    to_exclusive: to,
    timezone,
    level: query.level,
    daily: query.time_increment === "1",
    current_account_day: today,
    includes_partial_current_day: since <= today && today < to,
    action_report_time: query.action_report_time,
    attribution_policy: "adset_unified",
    metric_sources: metricSources,
    aggregation: "provider_row_only",
    reach_is_additive: false,
    costs_currency_units: "major",
    costs_derived_precision: 6,
    profile_followers_source: "separate_instagram_profile_observation",
    separate_requests_may_differ: true,
  };
}
