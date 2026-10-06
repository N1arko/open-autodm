import { z } from "zod";
import { ApiError } from "@/lib/transport/api";

export const metaId = z.string().regex(/^\d{1,30}$/);
export const accountInput = z
  .string()
  .regex(/^(act_)?\d{1,30}$/)
  .transform((s) => s.replace(/^act_/, ""));
export const tokenInput = z
  .string()
  .min(20)
  .max(4096)
  .regex(/^[A-Za-z0-9_.|~-]+$/);
export type Collection = "campaigns" | "adsets" | "ads" | "instagram_accounts";
const DAY = 86400000;
export function date(s: string) {
  const n = Date.parse(`${s}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(n) ||
    new Date(n).toISOString().slice(0, 10) !== s
  )
    throw new ApiError(400, "invalid_date");
  return n;
}
const day = (n: number) => new Date(n).toISOString().slice(0, 10);
export function localDay(timezone: string, now = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const p = Object.fromEntries(parts.map((v) => [v.type, v.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    throw new ApiError(502, "meta_invalid_timezone");
  }
}
function known(params: URLSearchParams, keys: string[]) {
  for (const key of params.keys())
    if (!keys.includes(key) || params.getAll(key).length !== 1)
      throw new ApiError(400, "invalid_query");
}
export function pagination(params: URLSearchParams) {
  const raw = params.get("limit") ?? "25",
    after = params.get("after");
  if (
    !/^\d{1,2}$/.test(raw) ||
    Number(raw) < 1 ||
    Number(raw) > 50 ||
    (after !== null && (!after || after.length > 2048 || /[\r\n]/.test(after)))
  )
    throw new ApiError(400, "invalid_pagination");
  return { limit: raw, ...(after ? { after } : {}) };
}
export function collectionQuery(params: URLSearchParams) {
  known(params, ["limit", "after", "refresh"]);
  return pagination(params);
}
export function forceRefresh(params: URLSearchParams) {
  const value = params.get("refresh");
  if (value !== null && value !== "true" && value !== "false")
    throw new ApiError(400, "invalid_refresh");
  return value === "true";
}
export function insightQuery(
  params: URLSearchParams,
  timezone: string,
  now = Date.now(),
) {
  known(params, [
    "from",
    "to",
    "level",
    "daily",
    "breakdown",
    "limit",
    "after",
    "refresh",
  ]);
  const today = date(localDay(timezone, now));
  const from = params.get("from") ?? day(today - 7 * DAY),
    to = params.get("to") ?? day(today);
  const start = date(from),
    end = date(to);
  if (
    end <= start ||
    end - start > 31 * DAY ||
    start < today - 1095 * DAY ||
    end > today + DAY
  )
    throw new ApiError(400, "invalid_date_range");
  const level = params.get("level") ?? "ad",
    daily = params.get("daily") ?? "false";
  const breakdown = params.get("breakdown") ?? "none";
  if (
    !["account", "campaign", "adset", "ad"].includes(level) ||
    !["true", "false"].includes(daily) ||
    ![
      "none",
      "country",
      "age,gender",
      "publisher_platform",
      "publisher_platform,platform_position",
    ].includes(breakdown)
  )
    throw new ApiError(400, "invalid_insights_query");
  return {
    ...pagination(params),
    level,
    time_range: JSON.stringify({ since: from, until: day(end - DAY) }),
    time_increment: daily === "true" ? "1" : "all_days",
    action_report_time: "impression",
    use_unified_attribution_setting: "true",
    ...(breakdown !== "none" ? { breakdowns: breakdown } : {}),
  };
}
