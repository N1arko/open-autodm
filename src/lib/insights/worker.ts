import { getEnv } from "@/lib/env";
import { transportStore, type TransportStore } from "@/lib/transport/store";
import { ApiError } from "@/lib/transport/api";
import { insightsMeta } from "./meta";
import {
  accessToken,
  collect,
  usable,
  type InsightsAccount,
  type InsightsPorts,
} from "./service";
import { ACCOUNT_METRICS, MEDIA_METRICS, DAY, utcDay, date } from "./queries";

type Claim = { account_id: string; claim_token: string; media_limit: number };
export async function drainInsights(
  store: TransportStore,
  ports: (signal: AbortSignal) => InsightsPorts,
  limit = 2,
) {
  const jobs = await store.rpc<Claim[]>("insights_claim", { p_limit: limit });
  await Promise.all(
    jobs.map(async (job) => {
      const signal = AbortSignal.timeout(240000),
        p = { ...ports(signal), store };
      let error: string | null = null;
      const context = () =>
        store.rpc<InsightsAccount | null>("insights_context", {
          p_account: job.account_id,
          p_claim: job.claim_token,
        });
      async function active() {
        if (signal.aborted) throw new Error("insights_collection_timeout");
        const a = await context();
        if (!a) throw new ApiError(409, "collection_cancelled");
        usable(a);
        return a;
      }
      try {
        const a = await active(),
          today = date(utcDay());
        // Re-read the preceding three complete UTC days to capture Meta's delayed updates.
        for (let back = 3; back >= 1; back--) {
          await active();
          await collect(
            a,
            a.instagram_user_id,
            {
              kind: "account",
              metrics: [...ACCOUNT_METRICS].sort(),
              from: utcDay(today - back * DAY),
              to: utcDay(today - (back - 1) * DAY),
            },
            p,
            false,
            job.claim_token,
          );
        }
        await active();
        await collect(
          a,
          a.instagram_user_id,
          {
            kind: "audience",
            metrics: ["follower_demographics"],
            breakdown: "country",
            timeframe: "this_month",
          },
          p,
          false,
          job.claim_token,
        );
        if (job.media_limit > 0) {
          const page = await p.meta.list(
            a.instagram_user_id,
            accessToken(a, p),
            job.media_limit,
          );
          for (const media of page.data) {
            await active();
            if (Date.parse(media.timestamp) < today - 90 * DAY) continue;
            const names = MEDIA_METRICS.filter(
              (n) =>
                n !== "ig_reels_avg_watch_time" || media.media_type === "VIDEO",
            );
            await collect(
              a,
              media.id,
              { kind: "media", metrics: [...names].sort() },
              p,
              false,
              job.claim_token,
            );
          }
        }
      } catch (e) {
        error =
          e instanceof ApiError
            ? e.message
            : signal.aborted
              ? "insights_collection_timeout"
              : "insights_unavailable";
      }
      await store.rpc("insights_finish", {
        p_account: job.account_id,
        p_claim: job.claim_token,
        p_error: error,
      });
    }),
  );
  return jobs.length;
}
export const processInsightsJobs = (limit = 2) =>
  drainInsights(
    transportStore,
    (signal) => ({
      meta: insightsMeta(fetch, undefined, signal),
      encryptionKey: getEnv().TOKEN_ENCRYPTION_KEY,
    }),
    limit,
  );
