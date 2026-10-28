import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import {
  ApiError,
  apiRoute,
  owner,
  respond,
  jsonBody,
  hash,
} from "@/lib/transport/api";
import {
  actionSchema,
  graphId,
  validId,
  pagination,
  idempotency,
  type Action,
} from "./input";
import { context, guard, verify, defaultEngagementPorts } from "./service";
import { ownedAccount } from "@/lib/insights/service";
const fields =
  "id,account_id,publication_id,action,input,status,receipt,error_code,attempts,started_at,created_at,updated_at,next_attempt_at";
const publicOperation = (row: Record<string, unknown>) =>
  Object.fromEntries(fields.split(",").map((k) => [k, row[k]]));
const uuid = (id: string) => {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(400, "invalid_id");
  return id;
};
async function operation(user: string, id: string) {
  const { data, error } = await createServiceClient()
    .from("instagram_operations")
    .select(fields)
    .eq("user_id", user)
    .eq("id", uuid(id))
    .maybeSingle();
  if (error) throw Error("db_unavailable");
  if (!data) throw new ApiError(404, "not_found");
  return data;
}
export const accountProfile = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p);
    return respond({
      account_id: id,
      profile: await p.meta.profile(account.instagram_user_id, token),
      source: "instagram_login",
      fetched_at: new Date().toISOString(),
      cached: false,
    });
  });
export const capabilities = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p);
    const results = await Promise.allSettled([
      p.meta.permissions(token),
      p.meta.subscriptions(account.instagram_user_id, token),
      p.meta.profile(account.instagram_user_id, token),
    ]);
    const grants =
      results[0].status === "fulfilled"
        ? (results[0].value.data as { permission: string; status: string }[])
        : null;
    const granted = new Set(
      grants?.filter((g) => g.status === "granted").map((g) => g.permission),
    );
    const access = (scope: string) =>
      grants === null ? "unknown" : granted.has(scope) ? "granted" : "missing";
    return respond({
      account_id: id,
      login_type: "instagram_login",
      graph_version: "v26.0",
      grants,
      grants_observed: grants !== null,
      subscriptions:
        results[1].status === "fulfilled" ? results[1].value.data : null,
      profile: results[2].status === "fulfilled" ? results[2].value : null,
      actions: {
        read: access("instagram_business_basic"),
        comments: access("instagram_business_manage_comments"),
        publishing: access("instagram_business_content_publish"),
        insights: access("instagram_business_manage_insights"),
        messages: access("instagram_business_manage_messages"),
      },
      supported_actions: actionSchema.options.map((s) => s.shape.action.value),
      limitations: {
        personal_accounts: false,
        stories_business_only: true,
        metadata_edit: false,
        media_delete: "requires_facebook_login_and_instagram_manage_contents",
        collaborators: "requires_facebook_login",
        app_review:
          "advanced_access_for_external_accounts_not_observable_from_token",
      },
      fetched_at: new Date().toISOString(),
      cached: false,
    });
  });
export const mediaDetails = (
  id: string,
  media: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p);
    return respond({
      account_id: id,
      media: await p.meta.media(
        account.instagram_user_id,
        validId(media),
        token,
      ),
      fetched_at: new Date().toISOString(),
      cached: false,
    });
  });
export const mediaChildren = (
  id: string,
  media: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p),
      page = pagination(new URL(request.url).searchParams);
    await p.meta.media(account.instagram_user_id, validId(media), token);
    return respond(await p.meta.children(media, token, page.limit, page.after));
  });
export const listComments = (
  id: string,
  media: string,
  comment?: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p),
      page = pagination(new URL(request.url).searchParams);
    await p.meta.media(account.instagram_user_id, validId(media), token);
    if (comment) await p.meta.comment(media, validId(comment), token);
    return respond(
      comment
        ? await p.meta.replies(comment, token, page.limit, page.after)
        : await p.meta.comments(media, token, page.limit, page.after),
    );
  });
export const getComment = (
  id: string,
  media: string,
  comment: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p);
    await p.meta.media(account.instagram_user_id, validId(media), token);
    return respond(await p.meta.comment(media, validId(comment), token));
  });
export const enqueueAction = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    const user = await owner(request),
      key = idempotency(request),
      input = await jsonBody(request, actionSchema, 16384),
      p = ports();
    // RPC resolves replay before checking current account availability. Ownership is checked there.
    return respond(
      publicOperation(
        await p.store.rpc<Record<string, unknown>>("instagram_enqueue", {
          p_user: user,
          p_account: uuid(id),
          p_action: input.action,
          p_input: Object.fromEntries(
            Object.entries(input).filter(([k]) => k !== "action"),
          ),
          p_key: key,
          p_hash: hash(JSON.stringify({ account_id: id, ...input })),
        }),
      ),
      202,
    );
  });
export const getOperation = (id: string) =>
  apiRoute(async (request) =>
    respond(await operation(await owner(request), id)),
  );
export const cancelOperation = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    return respond(
      publicOperation(
        await ports().store.rpc("instagram_cancel", {
          p_user: await owner(request),
          p_id: uuid(id),
        }),
      ),
    );
  });
export const listOperations = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    await ownedAccount(user, id);
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor) uuid(cursor);
    let q = createServiceClient()
      .from("instagram_operations")
      .select(fields)
      .eq("user_id", user)
      .eq("account_id", id)
      .order("id")
      .limit(51);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw Error("db_unavailable");
    return respond({
      data: data.slice(0, 50),
      next_cursor: data.length > 50 ? data[49]!.id : null,
    });
  });
export const reconcileOperation = (
  id: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const user = await owner(request),
      o = await operation(user, id),
      input = await jsonBody(
        request,
        z.object({ external_id: graphId.optional() }).strict(),
      ),
      p = ports();
    if (!["unknown", "succeeded"].includes(o.status))
      throw new ApiError(409, "operation_not_reconcilable");
    const { account, token } = await context(user, o.account_id, p),
      a = actionSchema.parse({ action: o.action, ...o.input }) as Action;
    await p.meta.media(account.instagram_user_id, a.media_id, token);
    if (a.action === "comment.delete")
      throw new ApiError(409, "delete_requires_manual_resolution");
    if (
      o.status === "succeeded" &&
      input.external_id &&
      input.external_id !== o.receipt?.external_id
    )
      throw new ApiError(409, "receipt_conflict");
    const external = input.external_id ?? o.receipt?.external_id;
    const result = await verify(a, token, p.meta, external);
    if (!result.verified) throw new ApiError(409, "result_not_verified");
    if (
      o.status === "unknown" &&
      (a.action === "comment.create" || a.action === "comment.reply")
    ) {
      const c = await p.meta.comment(a.media_id, external!, token),
        profile = await p.meta.profile(account.instagram_user_id, token);
      const timestamp = Date.parse(c.timestamp ?? "");
      if (
        !c.from?.username ||
        c.from.username !== profile.username ||
        !Number.isFinite(timestamp) ||
        timestamp < Date.parse(o.started_at) - 120000
      )
        throw new ApiError(409, "comment_identity_not_verified");
    }
    return respond(
      publicOperation(
        await p.store.rpc("instagram_reconcile", {
          p_user: user,
          p_id: id,
          p_receipt: {
            ...o.receipt,
            ...result,
            ...(external ? { external_id: external } : {}),
            reconciled: true,
            checked_at: new Date().toISOString(),
          },
        }),
      ),
    );
  });
export const listTags = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p),
      page = pagination(new URL(request.url).searchParams);
    return respond(
      await p.meta.tags(
        account.instagram_user_id,
        token,
        page.limit,
        page.after,
      ),
    );
  });
export const publishingLimit = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p);
    return respond({
      data: await p.meta.publishingLimit(account.instagram_user_id, token),
      fetched_at: new Date().toISOString(),
      cached: false,
    });
  });
export const events = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    await ownedAccount(user, id);
    const params = new URL(request.url).searchParams,
      after = params.get("after") ?? "0",
      limit = Number(params.get("limit") ?? 50);
    if (
      !/^\d{1,18}$/.test(after) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new ApiError(400, "invalid_pagination");
    const { data, error } = await createServiceClient()
      .from("instagram_events")
      .select("id,field,payload,occurred_at,received_at")
      .eq("user_id", user)
      .eq("account_id", id)
      .gt("id", after)
      .order("id")
      .limit(limit + 1);
    if (error) throw Error("db_unavailable");
    return respond({
      data: data.slice(0, limit).map((r) => ({ ...r, id: String(r.id) })),
      next_cursor: data.length > limit ? String(data[limit - 1]!.id) : null,
      last_cursor: data.length
        ? String(data[Math.min(limit, data.length) - 1]!.id)
        : after,
    });
  });
// Route aliases validate the small body before constructing a typed action request.
export function commentWrite(
  request: Request,
  id: string,
  media: string,
  comment?: string,
  ports = defaultEngagementPorts,
) {
  return apiRoute(async (request) => {
    await owner(request);
    const input = await jsonBody(
      request,
      z.object({ text: z.string().trim().min(1).max(2200) }).strict(),
    );
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return enqueueAction(
      id,
      ports,
    )(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: comment ? "comment.reply" : "comment.create",
          media_id: validId(media),
          ...(comment ? { comment_id: validId(comment) } : {}),
          ...input,
        }),
      }),
    );
  })(request);
}
export const publicationWorkflow = (id: string) =>
  apiRoute(async (request) => {
    const { getPublication } = await import("@/lib/publishing/api");
    const result = await getPublication(id)(request);
    if (!result.ok) return result;
    const publication = await result.json();
    const comment = publication.first_comment_operation_id
      ? await operation(
          await owner(request),
          publication.first_comment_operation_id,
        )
      : null;
    const state = ["failed", "cancelled", "publication_unknown"].includes(
      publication.status,
    )
      ? "needs_attention"
      : publication.status !== "published"
        ? "waiting_publication"
        : !comment
          ? "completed"
          : comment.status === "succeeded"
            ? comment.receipt?.verified
              ? "completed"
              : "verification_pending"
            : ["failed", "unknown", "cancelled"].includes(comment.status)
              ? "needs_attention"
              : "waiting_comment";
    return respond({ state, publication, first_comment: comment });
  });
export const listConversations = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    await ownedAccount(user, id);
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor) uuid(cursor);
    let q = createServiceClient()
      .from("bot_conversations")
      .select("id,account_id,sender_id,paused,last_inbound_at,created_at")
      .eq("account_id", id)
      .order("id")
      .limit(51);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw Error("db_unavailable");
    return respond({
      data: data.slice(0, 50),
      next_cursor: data.length > 50 ? data[49]!.id : null,
      coverage: "stored_bot_transport_only",
    });
  });
export const conversationMessages = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request),
      db = createServiceClient();
    const { data: c, error: ce } = await db
      .from("bot_conversations")
      .select("id,account_id")
      .eq("id", uuid(id))
      .maybeSingle();
    if (ce) throw Error("db_unavailable");
    if (!c) throw new ApiError(404, "not_found");
    await ownedAccount(user, c.account_id);
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor) uuid(cursor);
    let q = db
      .from("bot_messages")
      .select(
        "id,direction,text,external_id,status,error_code,occurred_at,in_reply_to_event_id",
      )
      .eq("conversation_id", id)
      .order("id")
      .limit(51);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw Error("db_unavailable");
    return respond({
      data: data.slice(0, 50),
      next_cursor: data.length > 50 ? data[49]!.id : null,
      coverage: "stored_bot_transport_only",
    });
  });
export const validateAction = (id: string, ports = defaultEngagementPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p),
      a = await jsonBody(request, actionSchema, 16384);
    await guard(a, account.instagram_user_id, token, p.meta);
    let permission = "unknown";
    try {
      const grants = await p.meta.permissions(token);
      permission = grants.data.some(
        (g) =>
          g.permission === "instagram_business_manage_comments" &&
          g.status === "granted",
      )
        ? "granted"
        : "missing";
    } catch {
      /* Leave unknown; do not infer from requested OAuth scopes. */
    }
    return respond({
      action: a,
      ownership_verified: true,
      comments_permission: permission,
      external_write_performed: false,
      provider_write_validation: "not_available",
      fetched_at: new Date().toISOString(),
    });
  });

export const inboxConversations = (
  id: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p),
      page = pagination(new URL(request.url).searchParams);
    return respond({
      ...(await p.meta.conversations(
        account.instagram_user_id,
        token,
        page.limit,
        page.after,
      )),
      source: "meta_live",
      fetched_at: new Date().toISOString(),
      cached: false,
    });
  });
export const inboxMessages = (
  id: string,
  conversation: string,
  ports = defaultEngagementPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      { account, token } = await context(await owner(request), id, p),
      page = pagination(
        new URL(request.url).searchParams.has("limit")
          ? new URL(request.url).searchParams
          : new URLSearchParams([
              ...new URL(request.url).searchParams,
              ["limit", "20"],
            ]),
      );
    if (!/^[A-Za-z0-9_.:=+-]{1,1024}$/.test(conversation) || page.limit > 20)
      throw new ApiError(400, "invalid_conversation_query");
    const c = await p.meta.conversation(
      account.instagram_user_id,
      conversation,
      token,
    );
    return respond({
      ...(await p.meta.inboxMessages(
        conversation,
        token,
        page.limit,
        page.after,
      )),
      conversation: c,
      source: "meta_live",
      fetched_at: new Date().toISOString(),
      cached: false,
    });
  });
