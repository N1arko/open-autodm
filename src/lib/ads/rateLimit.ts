/** Public, sanitized retry guidance; Meta usage headers can contain account IDs. */
export function retryAfter(headers: Headers, now = Date.now()) {
  const raw = headers.get("retry-after");
  let seconds =
    raw && /^\d+$/.test(raw)
      ? Number(raw)
      : raw
        ? Math.ceil((Date.parse(raw) - now) / 1000)
        : 0;
  let source: "retry_after" | "business_usage" | "default" =
    seconds > 0 ? "retry_after" : "default";
  try {
    const usage = JSON.parse(headers.get("x-business-use-case-usage") ?? "{}");
    const estimates = Object.values(usage)
      .flatMap((v) => (Array.isArray(v) ? v : []))
      .map((v) => Number(v?.estimated_time_to_regain_access))
      .filter((v) => Number.isFinite(v) && v > 0);
    const estimate = Math.max(0, ...estimates) * 60;
    if (estimate > (seconds || 0)) {
      seconds = estimate;
      source = "business_usage";
    }
  } catch {
    /* Unavailable estimates do not suppress the rate-limit error. */
  }
  return {
    seconds: Math.min(86400, Math.max(1, Math.ceil(seconds || 60))),
    source,
  };
}
export const isRateLimit = (status: number, code: number) =>
  status === 429 ||
  [4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006].includes(
    code,
  );
