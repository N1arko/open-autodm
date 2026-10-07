import { ApiError, apiRoute, owner, respond } from "@/lib/transport/api";
import { account, token } from "./service";
import { defaultManagePorts, type ManagePorts } from "./manage";
import type { TransportStore } from "@/lib/transport/store";

export async function inspectCredential(
  user: string,
  id: string,
  p: ManagePorts,
) {
  const a = await account(user, id, p);
  let health: Record<string, unknown>;
  try {
    const v = await p.writer.credential(token(a, p)),
      now = Math.floor(Date.now() / 1000);
    const expiry = [v.expires_at, v.data_access_expires_at].filter(
      (n): n is number => typeof n === "number" && n > 0,
    );
    const expires = expiry.length ? Math.min(...expiry) : null;
    health = {
      status:
        !v.is_valid || (expires !== null && expires <= now)
          ? "invalid"
          : expires !== null && expires - now < 7 * 86400
            ? "expiring"
            : "valid",
      type: v.type ?? "unknown",
      app_id: v.app_id ?? null,
      scopes: v.scopes,
      token_expires_at: v.expires_at
        ? new Date(v.expires_at * 1000).toISOString()
        : null,
      data_access_expires_at: v.data_access_expires_at
        ? new Date(v.data_access_expires_at * 1000).toISOString()
        : null,
      renewal_required_by: expires
        ? new Date(expires * 1000).toISOString()
        : null,
      renewal_method:
        v.type === "SYSTEM_USER" && v.expires_at === 0
          ? "system_user_no_scheduled_expiry"
          : "reauthorize_or_replace_with_system_user",
      automatic_user_token_refresh: false,
      permissions: {
        ads_read: v.scopes.includes("ads_read"),
        ads_management: v.scopes.includes("ads_management"),
        business_management: v.scopes.includes("business_management"),
        catalog_management: v.scopes.includes("catalog_management"),
      },
    };
  } catch (e) {
    health = {
      status:
        e instanceof ApiError && e.message === "ads_token_unavailable"
          ? "invalid"
          : "inspection_unavailable",
      error: e instanceof ApiError ? e.message : "meta_unavailable",
      automatic_user_token_refresh: false,
    };
  }
  if (
    !(await p.store.rpc("ads_credential_health_set", {
      p_user: user,
      p_account: id,
      p_revision: a.revision,
      p_health: health,
    }))
  )
    throw new ApiError(409, "ads_connection_changed");
  return { health, checked_at: new Date().toISOString() };
}
export const credentialStatus = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      q = new URL(request.url).searchParams;
    if (
      [...q.keys()].some((k) => k !== "refresh") ||
      q.getAll("refresh").length > 1 ||
      (q.has("refresh") && !["true", "false"].includes(q.get("refresh")!))
    )
      throw new ApiError(400, "invalid_query");
    if (q.get("refresh") !== "true") {
      const saved = await p.store.rpc<{
        health: Record<string, unknown>;
        checked_at: string;
      } | null>("ads_credential_health_get", {
        p_user: a.user_id,
        p_account: a.id,
      });
      if (saved && Date.now() - Date.parse(saved.checked_at) < 86400000)
        return respond({ ...saved, cached: true });
    }
    return respond({
      ...(await inspectCredential(a.user_id, a.id, p)),
      cached: false,
    });
  });
export async function monitorCredentials(
  store: TransportStore,
  ports = defaultManagePorts,
) {
  const due = await store.rpc<{ id: string; user_id: string }[]>(
    "ads_credential_health_due",
  );
  for (const a of due)
    await inspectCredential(a.user_id, a.id, { ...ports(), store });
  return due.length;
}
