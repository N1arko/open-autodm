import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
import { date, type InsightQuery } from "./queries";

export class InsightsMetaError extends ApiError {
  constructor(
    public code: string,
    public providerCode = 0,
  ) {
    super(
      code === "insights_permission_required"
        ? 403
        : code === "account_unavailable"
          ? 409
          : code === "meta_rate_limited"
            ? 429
            : 502,
      code,
    );
  }
}
const number = z.number().finite();
const metricSchema = z.object({
  name: z.string().max(100),
  period: z.string().max(50),
  values: z
    .array(
      z.object({ value: number, end_time: z.string().max(100).optional() }),
    )
    .max(500)
    .optional(),
  total_value: z
    .object({
      value: number.optional(),
      breakdowns: z
        .array(
          z.object({
            dimension_keys: z.array(z.string().max(100)).max(10),
            results: z
              .array(
                z.object({
                  dimension_values: z.array(z.string().max(200)).max(10),
                  value: number,
                }),
              )
              .max(500),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
});
export type Metric = z.infer<typeof metricSchema>;
const mediaSchema = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  media_type: z.enum(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]),
  permalink: z.string().url().optional(),
  timestamp: z.string().datetime({ offset: true }),
  owner: z.union([z.string(), z.object({ id: z.string() })]).optional(),
});
export type Media = z.infer<typeof mediaSchema>;
export interface InsightsMeta {
  profile(
    account: string,
    token: string,
  ): Promise<{ followers_count: number | null; media_count: number | null }>;
  media(account: string, id: string, token: string): Promise<Media>;
  list(
    account: string,
    token: string,
    limit: number,
    after?: string,
  ): Promise<{ data: Media[]; next_cursor: string | null }>;
  insights(
    target: string,
    token: string,
    query: InsightQuery,
  ): Promise<{
    metrics: Metric[];
    unavailable_metrics: { name: string; reason: string }[];
  }>;
}
/** Read-only Instagram Login API. A fixed host, Bearer header, deadline and bounded responses. */
export function insightsMeta(
  fetcher: typeof fetch = fetch,
  base = "https://graph.instagram.com/v26.0",
  signal?: AbortSignal,
): InsightsMeta {
  async function call(
    path: string,
    token: string,
    params: Record<string, string>,
  ) {
    let res: Response, data: Record<string, unknown>;
    try {
      res = await fetcher(`${base}/${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(12000),
          ...(signal ? [signal] : []),
        ]),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 262144) {
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
      throw new InsightsMetaError("meta_unavailable");
    }
    if (!res.ok || data.error) {
      if (res.status >= 500) throw new InsightsMetaError("meta_unavailable");
      const err = data.error as { code?: number } | undefined,
        code = Number.isInteger(err?.code) ? err!.code! : 0;
      throw new InsightsMetaError(
        code === 190
          ? "account_unavailable"
          : res.status === 429 || [4, 17, 32, 613].includes(code)
            ? "meta_rate_limited"
            : [10, 200].includes(code) || res.status === 403
              ? "insights_permission_required"
              : "meta_rejected",
        code,
      );
    }
    return data;
  }
  async function readMetrics(
    target: string,
    token: string,
    query: InsightQuery,
    names: string[],
  ) {
    const params: Record<string, string> = { metric: names.join(",") };
    if (query.kind !== "media")
      Object.assign(params, {
        period: query.kind === "audience" ? "lifetime" : "day",
        metric_type: "total_value",
      });
    if (query.from && query.to)
      Object.assign(params, {
        since: String(date(query.from) / 1000),
        until: String(date(query.to) / 1000 - 1),
      });
    if (query.breakdown) params.breakdown = query.breakdown;
    if (query.timeframe) params.timeframe = query.timeframe;
    const data = await call(`${target}/insights`, token, params);
    const parsed = z.array(metricSchema).max(20).safeParse(data.data);
    if (!parsed.success) throw new InsightsMetaError("meta_invalid_response");
    const present = parsed.data.filter(
      (m) =>
        names.includes(m.name) &&
        ((m.values?.length ?? 0) > 0 ||
          typeof m.total_value?.value === "number" ||
          m.total_value?.breakdowns?.some((b) => b.results.length > 0)),
    );
    return {
      metrics: present,
      unavailable_metrics: names
        .filter((name) => !present.some((m) => m.name === name))
        .map((name) => ({ name, reason: "no_data" })),
    };
  }
  async function compatible(
    target: string,
    token: string,
    q: InsightQuery,
    names: string[],
  ) {
    try {
      return await readMetrics(target, token, q, names);
    } catch (e) {
      if (!(e instanceof InsightsMetaError) || e.providerCode !== 100) throw e;
      if (names.length === 1)
        return {
          metrics: [],
          unavailable_metrics: [
            { name: names[0]!, reason: "provider_rejected" },
          ],
        };
      // Split only a known metric-compatibility rejection. Credential/rate/network errors stay errors.
      const out: {
        metrics: Metric[];
        unavailable_metrics: { name: string; reason: string }[];
      } = { metrics: [], unavailable_metrics: [] };
      for (let i = 0; i < names.length; i += 3) {
        const parts = await Promise.all(
          names
            .slice(i, i + 3)
            .map((name) => compatible(target, token, q, [name])),
        );
        for (const p of parts) {
          out.metrics.push(...p.metrics);
          out.unavailable_metrics.push(...p.unavailable_metrics);
        }
      }
      return out;
    }
  }
  return {
    async profile(account, token) {
      const data = await call(account, token, {
        fields: "followers_count,media_count",
      });
      return {
        followers_count:
          typeof data.followers_count === "number" &&
          Number.isSafeInteger(data.followers_count) &&
          data.followers_count >= 0
            ? data.followers_count
            : null,
        media_count:
          typeof data.media_count === "number" &&
          Number.isSafeInteger(data.media_count) &&
          data.media_count >= 0
            ? data.media_count
            : null,
      };
    },
    async media(account, id, token) {
      const data = await call(id, token, {
        fields: "id,owner,media_type,permalink,timestamp",
      });
      const parsed = mediaSchema.safeParse(data);
      if (!parsed.success) throw new InsightsMetaError("meta_invalid_response");
      const owner =
        typeof parsed.data.owner === "string"
          ? parsed.data.owner
          : parsed.data.owner?.id;
      if (!owner || !/^\d{1,30}$/.test(owner) || parsed.data.id !== id)
        throw new ApiError(404, "media_not_found");
      if (owner !== account) {
        // Instagram Login can return an API-scoped owner.id while OAuth's
        // user_id is the account ID we store. Prove both belong to this token.
        const identity = await call("me", token, { fields: "id,user_id" });
        if (identity.user_id !== account || identity.id !== owner)
          throw new ApiError(404, "media_not_found");
      }
      return parsed.data;
    },
    async list(account, token, limit, after) {
      const data = await call(`${account}/media`, token, {
        fields: "id,media_type,permalink,timestamp",
        limit: String(limit),
        ...(after ? { after } : {}),
      });
      const parsed = z
        .object({
          data: z.array(mediaSchema).max(50),
          paging: z
            .object({
              cursors: z
                .object({ after: z.string().max(2048).optional() })
                .optional(),
              next: z.string().optional(),
            })
            .optional(),
        })
        .safeParse(data);
      if (!parsed.success) throw new InsightsMetaError("meta_invalid_response");
      return {
        data: parsed.data.data,
        next_cursor: parsed.data.paging?.next
          ? (parsed.data.paging.cursors?.after ?? null)
          : null,
      };
    },
    async insights(target, token, q) {
      const names = q.metrics.filter((n) => n !== "follows_and_unfollows");
      const out = names.length
        ? await compatible(target, token, q, names)
        : { metrics: [], unavailable_metrics: [] };
      if (q.metrics.includes("follows_and_unfollows")) {
        const f = await compatible(
          target,
          token,
          { ...q, breakdown: "follow_type" },
          ["follows_and_unfollows"],
        );
        out.metrics.push(...f.metrics);
        out.unavailable_metrics.push(...f.unavailable_metrics);
      }
      return out;
    },
  };
}
