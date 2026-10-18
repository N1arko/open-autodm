export interface UsageValues {
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
}
export interface MetaUsage {
  observed_at: string;
  app?: UsageValues;
  ad_account?: {
    acc_id_util_pct?: number;
    reset_time_duration_seconds?: number;
    access_tier?: string;
  };
  business?: (UsageValues & {
    type?: string;
    estimated_regain_access_minutes?: number;
    access_tier?: string;
  })[];
}
export interface RetryPolicy {
  strategy: "exponential_positive_jitter";
  base_seconds: number;
  maximum_base_seconds: number;
  minimum_delay_seconds: number;
  jitter_ratio: number;
  recovery_time_known: false;
}
export type RetryInfo = {
  seconds: number;
  source: "retry_after" | "business_usage" | "ad_account_usage" | "default";
  usage?: MetaUsage;
  policy?: RetryPolicy;
};
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e6
    ? v
    : undefined;
function header(
  headers: Headers,
  key: string,
): Record<string, unknown> | undefined {
  const value = headers.get(key);
  if (!value || value.length > 16384) return;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return;
  }
}
function values(row: Record<string, unknown>): UsageValues {
  return Object.fromEntries(
    ["call_count", "total_cputime", "total_time"].flatMap((k) =>
      number(row[k]) === undefined ? [] : [[k, number(row[k])]],
    ),
  );
}
const tier = (value: unknown) =>
  typeof value === "string" &&
  ["development_access", "standard_access"].includes(value)
    ? value
    : undefined;
/** Whitelisted numeric signals; business IDs, app IDs, arbitrary headers/text are excluded. */
export function metaUsage(
  headers: Headers,
  now = Date.now(),
): MetaUsage | undefined {
  const result: MetaUsage = { observed_at: new Date(now).toISOString() };
  const app = header(headers, "x-app-usage");
  if (app && Object.keys(values(app)).length) result.app = values(app);
  const ad = header(headers, "x-ad-account-usage");
  if (ad) {
    const usage = {
      acc_id_util_pct: number(ad.acc_id_util_pct),
      reset_time_duration_seconds: number(ad.reset_time_duration),
      access_tier: tier(ad.ads_api_access_tier),
    };
    if (Object.values(usage).some((v) => v !== undefined))
      result.ad_account = usage;
  }
  const business = header(headers, "x-business-use-case-usage");
  if (business) {
    const rows = Object.values(business)
      .filter(Array.isArray)
      .flat()
      .slice(0, 20)
      .flatMap((row: unknown) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return [];
        const v = row as Record<string, unknown>;
        const usage = {
          ...values(v),
          type:
            typeof v.type === "string" &&
            [
              "ads_management",
              "ads_insights",
              "custom_audience",
              "pages",
              "instagram",
            ].includes(v.type)
              ? v.type
              : undefined,
          estimated_regain_access_minutes: number(
            v.estimated_time_to_regain_access,
          ),
          access_tier: tier(v.ads_api_access_tier),
        };
        return Object.values(usage).some((v) => v !== undefined) ? [usage] : [];
      });
    if (rows.length) result.business = rows;
  }
  return Object.keys(result).length > 1 ? result : undefined;
}
/** Provider delays are estimates/lower bounds, never a promise that access has recovered. */
export function retryAfter(headers: Headers, now = Date.now(), code = 0) {
  const raw = headers.get("retry-after");
  let seconds =
    raw && /^\d+$/.test(raw)
      ? Number(raw)
      : raw
        ? Math.ceil((Date.parse(raw) - now) / 1000)
        : 0;
  let source: RetryInfo["source"] = seconds > 0 ? "retry_after" : "default";
  const usage = metaUsage(headers, now);
  const estimate =
    Math.max(
      0,
      ...(usage?.business ?? []).map(
        (v) => v.estimated_regain_access_minutes ?? 0,
      ),
    ) * 60;
  if (estimate > (seconds || 0)) {
    seconds = estimate;
    source = "business_usage";
  }
  const reset = usage?.ad_account?.reset_time_duration_seconds ?? 0;
  if (reset > (seconds || 0)) {
    seconds = reset;
    source = "ad_account_usage";
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    seconds = code === 17 ? 300 : 60;
    source = "default";
  }
  return {
    seconds: Math.min(86400, Math.max(1, Math.ceil(seconds || 60))),
    source,
  };
}
export function rateLimitDetails(
  headers: Headers,
  code: number,
  now = Date.now(),
): RetryInfo {
  const retry = retryAfter(headers, now, code),
    usage = metaUsage(headers, now);
  return {
    ...retry,
    ...(usage ? { usage } : {}),
    policy: {
      strategy: "exponential_positive_jitter",
      base_seconds: code === 17 ? 300 : 60,
      maximum_base_seconds: 3600,
      minimum_delay_seconds: retry.seconds,
      jitter_ratio: 0.2,
      recovery_time_known: false,
    },
  };
}
/** Calling client tracks consecutive failures and shared account cooldown; this never sends a request. */
export function retryDelay(
  policy: RetryPolicy,
  consecutiveFailures: number,
  random = Math.random,
): number {
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(1, Math.min(20, Math.floor(consecutiveFailures)))
    : 1;
  const exponential = Math.min(
    policy.maximum_base_seconds,
    policy.base_seconds * 2 ** (failures - 1),
  );
  const r = random(),
    jitter = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
  return Math.ceil(
    Math.max(policy.minimum_delay_seconds, exponential) *
      (1 + jitter * policy.jitter_ratio),
  );
}
export const isRateLimit = (status: number, code: number) =>
  status === 429 ||
  [4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006].includes(
    code,
  );
