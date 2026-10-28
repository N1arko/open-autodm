import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { ownedAccount, usable } from "@/lib/insights/service";
import { transportStore, type TransportStore } from "@/lib/transport/store";
import { ApiError } from "@/lib/transport/api";
import { engagementMeta, type EngagementMeta } from "./meta";
import type { Action } from "./input";
export type EngagementPorts = {
  meta: EngagementMeta;
  encryptionKey: string;
  store: TransportStore;
};
export const defaultEngagementPorts = (): EngagementPorts => ({
  meta: engagementMeta(),
  encryptionKey: getEnv().TOKEN_ENCRYPTION_KEY,
  store: transportStore,
});
export async function context(user: string, id: string, p: EngagementPorts) {
  const account = await ownedAccount(user, id);
  usable(account);
  return {
    account,
    token: decrypt(account.access_token_encrypted, p.encryptionKey),
  };
}
export async function guard(
  a: Action,
  account: string,
  token: string,
  meta: EngagementMeta,
) {
  await meta.media(account, a.media_id, token);
  if ("comment_id" in a) await meta.comment(a.media_id, a.comment_id, token);
}
export async function verify(
  a: Action,
  token: string,
  meta: EngagementMeta,
  externalId?: string,
) {
  if (a.action === "comment.create" || a.action === "comment.reply") {
    if (!externalId) throw new ApiError(409, "external_id_required");
    const c = await meta.comment(a.media_id, externalId, token);
    return {
      verified:
        c.text === a.text &&
        (a.action !== "comment.reply" || c.parent_id === a.comment_id),
      comment: c,
    };
  }
  if (a.action === "comment.hide") {
    const c = await meta.comment(a.media_id, a.comment_id, token);
    return { verified: c.hidden === a.hidden, hidden: c.hidden };
  }
  if (a.action === "media.comments") {
    const enabled = await meta.commentsEnabled(a.media_id, token);
    return { verified: enabled === a.enabled, enabled };
  }
  return { verified: false, verification: "delete_acknowledgement_only" };
}
