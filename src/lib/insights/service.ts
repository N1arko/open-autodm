import { z } from "zod";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { ApiError, hash } from "@/lib/transport/api";
import { transportStore, type TransportStore } from "@/lib/transport/store";
import { insightsMeta, type InsightsMeta, type Media } from "./meta";
import { utcDay, type InsightQuery } from "./queries";

export interface InsightsAccount {
  id: string;
  user_id: string;
  instagram_user_id: string;
  access_token_encrypted: string;
  is_active: boolean;
  token_expires_at: string | null;
  paused_until: string | null;
}
export type InsightsPorts = {
  meta: InsightsMeta;
  encryptionKey: string;
  store?: TransportStore;
};
export const defaultInsightsPorts = (): InsightsPorts => ({
  meta: insightsMeta(fetch, undefined, AbortSignal.timeout(45000)),
  encryptionKey: getEnv().TOKEN_ENCRYPTION_KEY,
  store: transportStore,
});
export async function ownedAccount(
  user: string,
  id: string,
): Promise<InsightsAccount> {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(400, "invalid_account");
  const { data, error } = await createServiceClient()
    .from("instagram_accounts")
    .select(
      "id,user_id,instagram_user_id,access_token_encrypted,is_active,token_expires_at,paused_until",
    )
    .eq("id", id)
    .eq("user_id", user)
    .maybeSingle();
  if (error) throw new Error("db_unavailable");
  if (!data) throw new ApiError(404, "not_found");
  return data as InsightsAccount;
}
export function usable(a: InsightsAccount) {
  if (
    !a.is_active ||
    (a.token_expires_at && Date.parse(a.token_expires_at) <= Date.now()) ||
    (a.paused_until && Date.parse(a.paused_until) > Date.now())
  )
    throw new ApiError(409, "account_unavailable");
}
export const accessToken = (a: InsightsAccount, p: InsightsPorts) =>
  decrypt(a.access_token_encrypted, p.encryptionKey);
/** Responses carry both the measurement window and observation timestamp. Never synthesize missing values. */
export async function collect(
  a: InsightsAccount,
  target: string,
  q: InsightQuery,
  p: InsightsPorts,
  force = false,
  claim: string | null = null,
) {
  usable(a);
  const queryHash = hash(JSON.stringify(q));
  const { data: cached, error } = await createServiceClient()
    .from("instagram_insights_snapshots")
    .select("payload,fetched_at,collected_on")
    .eq("user_id", a.user_id)
    .eq("account_id", a.id)
    .eq("kind", q.kind)
    .eq("target_id", target)
    .eq("query_hash", queryHash)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("db_unavailable");
  if (
    !force &&
    cached &&
    cached.collected_on === utcDay() &&
    Date.parse(cached.fetched_at) > Date.now() - 15 * 60000
  )
    return { ...cached.payload, fetched_at: cached.fetched_at, cached: true };
  const token = accessToken(a, p);
  let media: Media | undefined,
    profile: Awaited<ReturnType<InsightsMeta["profile"]>> | undefined;
  if (q.kind === "media")
    media = await p.meta.media(a.instagram_user_id, target, token);
  const insight = await p.meta.insights(target, token, q);
  if (q.kind === "account")
    profile = await p.meta.profile(a.instagram_user_id, token);
  const payload = {
    account_id: a.id,
    target_id: target,
    query: q,
    ...insight,
    ...(media
      ? {
          media: {
            id: media.id,
            media_type: media.media_type,
            permalink: media.permalink ?? null,
            timestamp: media.timestamp,
          },
        }
      : {}),
    ...(profile
      ? { profile, profile_observed_at: new Date().toISOString() }
      : {}),
    source: "instagram_graph_api",
    data_delay_hours: 48,
  };
  const store = p.store ?? transportStore;
  const saved = await store.rpc<boolean>("insights_save", {
    p_user: a.user_id,
    p_account: a.id,
    p_kind: q.kind,
    p_target: target,
    p_hash: queryHash,
    p_query: q,
    p_payload: payload,
    p_claim: claim,
  });
  if (!saved) throw new ApiError(409, "collection_cancelled");
  return { ...payload, fetched_at: new Date().toISOString(), cached: false };
}
export const settingsFields =
  "account_id,enabled,media_limit,retention_days,next_run_at,last_collected_at,last_error,updated_at";
export async function settings(a: InsightsAccount) {
  const { data, error } = await createServiceClient()
    .from("instagram_insights_settings")
    .select(settingsFields)
    .eq("account_id", a.id)
    .eq("user_id", a.user_id)
    .maybeSingle();
  if (error) throw new Error("db_unavailable");
  return (
    data ?? {
      account_id: a.id,
      enabled: false,
      media_limit: 10,
      retention_days: 90,
      next_run_at: null,
      last_collected_at: null,
      last_error: null,
      updated_at: null,
    }
  );
}
