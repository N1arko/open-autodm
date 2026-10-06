import { z } from "zod";
import { decrypt, encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { ApiError, hash } from "@/lib/transport/api";
import { transportStore, type TransportStore } from "@/lib/transport/store";
import { adsMeta, type AdsMeta, type AdsMetadata } from "./meta";
import { insightQuery, type Collection } from "./queries";

export interface AdsPorts {
  meta: AdsMeta;
  encryptionKey: string;
  store: TransportStore;
}
export const defaultAdsPorts = (): AdsPorts => ({
  meta: adsMeta(),
  encryptionKey: getEnv().TOKEN_ENCRYPTION_KEY,
  store: transportStore,
});
export interface AdsAccount {
  id: string;
  user_id: string;
  ad_account_id: string;
  access_token_encrypted: string;
  metadata: AdsMetadata;
  enabled: boolean;
  revision: number;
  verified_at: string;
  created_at: string;
  updated_at: string;
}
export async function account(user: string, id: string, p: AdsPorts) {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(404, "not_found");
  const row = await p.store.rpc<AdsAccount | null>("ads_context", {
    p_user: user,
    p_account: id,
  });
  if (!row || row.user_id !== user) throw new ApiError(404, "not_found");
  return row;
}
export function visible(a: AdsAccount) {
  const { user_id: _user, access_token_encrypted: _token, ...publicData } = a;
  return {
    ...publicData,
    capabilities: { read: true, manage: false },
    credential_expiry: "not_inspected",
  };
}
export function token(a: AdsAccount, p: AdsPorts) {
  if (!a.enabled) throw new ApiError(409, "ads_connection_disabled");
  try {
    return decrypt(a.access_token_encrypted, p.encryptionKey);
  } catch {
    throw new ApiError(409, "ads_token_unavailable");
  }
}
export async function verify(id: string, access: string, p: AdsPorts) {
  const metadata = await p.meta.profile(id, access);
  // Reading basic account metadata alone does not prove permission to read Insights.
  await p.meta.insights(id, access, {
    ...insightQuery(
      new URLSearchParams("level=account&limit=1"),
      metadata.timezone_name,
    ),
    limit: "1",
  });
  return metadata;
}
export const ciphertext = (value: string, p: AdsPorts) =>
  encrypt(value, p.encryptionKey);
export async function read(
  a: AdsAccount,
  kind: Collection | "insights" | "status",
  query: Record<string, string>,
  p: AdsPorts,
  refresh = false,
) {
  const access = token(a, p),
    queryHash = hash(JSON.stringify({ kind, query }));
  const args = {
    p_user: a.user_id,
    p_account: a.id,
    p_revision: a.revision,
    p_hash: queryHash,
  };
  if (!refresh) {
    const cached = await p.store.rpc<{
      payload: Record<string, unknown>;
      fetched_at: string;
    } | null>("ads_cached", args);
    if (cached)
      return { ...cached.payload, fetched_at: cached.fetched_at, cached: true };
  }
  const data =
    kind === "status"
      ? { metadata: await verify(a.ad_account_id, access, p) }
      : kind === "insights"
        ? await p.meta.insights(a.ad_account_id, access, query)
        : await p.meta.list(a.ad_account_id, access, kind, query);
  const payload = {
    account_id: a.id,
    ad_account_id: a.ad_account_id,
    source: "meta_marketing_api",
    graph_version: "v26.0",
    timezone: a.metadata.timezone_name,
    currency: a.metadata.currency,
    kind,
    query,
    ...data,
  };
  const saved = await p.store.rpc<boolean>("ads_save", {
    ...args,
    p_payload: payload,
  });
  if (!saved) throw new ApiError(409, "ads_connection_changed");
  return { ...payload, fetched_at: new Date().toISOString(), cached: false };
}
