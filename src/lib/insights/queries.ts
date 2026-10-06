import { ApiError } from "@/lib/transport/api";

export const ACCOUNT_METRICS = [
  "views",
  "reach",
  "accounts_engaged",
  "total_interactions",
  "likes",
  "comments",
  "saves",
  "shares",
  "follows_and_unfollows",
];
export const MEDIA_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "saved",
  "shares",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "reposts",
];
export const DAY = 86400_000;
export const utcDay = (at = Date.now()) =>
  new Date(at).toISOString().slice(0, 10);
export function date(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ApiError(400, "invalid_date");
  const ms = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(ms) || utcDay(ms) !== value)
    throw new ApiError(400, "invalid_date");
  return ms;
}
export function range(params: URLSearchParams, now = Date.now(), max = 90) {
  const to = params.get("to") ?? utcDay(now),
    from = params.get("from") ?? utcDay(date(to) - 7 * DAY);
  const start = date(from),
    end = date(to),
    today = date(utcDay(now));
  if (
    start >= end ||
    end > today + DAY ||
    start < today - max * DAY ||
    end - start > max * DAY
  )
    throw new ApiError(400, "invalid_range");
  return { from, to };
}
export function metrics(
  params: URLSearchParams,
  allowed: string[],
  defaults = allowed,
) {
  const raw = params.get("metrics");
  const list = raw === null ? defaults : raw.split(",");
  if (
    !list.length ||
    (raw && raw.length > 512) ||
    list.some((m) => !allowed.includes(m))
  )
    throw new ApiError(400, "invalid_metrics");
  return [...new Set(list)].sort();
}
export function refresh(params: URLSearchParams) {
  const value = params.get("refresh");
  if (value !== null && value !== "true" && value !== "false")
    throw new ApiError(400, "invalid_refresh");
  return value === "true";
}
export function mediaId(id: string) {
  if (!/^\d{1,30}$/.test(id)) throw new ApiError(400, "invalid_media_id");
  return id;
}
export type InsightQuery = {
  kind: "account" | "media" | "audience";
  metrics: string[];
  from?: string;
  to?: string;
  breakdown?: string;
  timeframe?: string;
};
export function accountQuery(params: URLSearchParams): InsightQuery {
  return {
    kind: "account",
    metrics: metrics(params, ACCOUNT_METRICS),
    ...range(params),
  };
}
export function audienceQuery(params: URLSearchParams): InsightQuery {
  const metric = params.get("metric") ?? "follower_demographics";
  const breakdown = params.get("breakdown") ?? "country",
    timeframe = params.get("timeframe") ?? "this_month";
  if (
    !["follower_demographics", "engaged_audience_demographics"].includes(
      metric,
    ) ||
    !["country", "city", "age", "gender"].includes(breakdown) ||
    !["this_month", "this_week"].includes(timeframe)
  )
    throw new ApiError(400, "invalid_audience_query");
  return { kind: "audience", metrics: [metric], breakdown, timeframe };
}
