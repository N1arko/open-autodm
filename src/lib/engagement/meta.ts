import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
import { insightsMeta } from "@/lib/insights/meta";
import { graphId, type Action } from "./input";
export class EngagementError extends ApiError {
  constructor(
    code: string,
    public retryable = false,
    public uncertain = false,
    public providerCode = 0,
  ) {
    super(
      code === "comments_permission_required"
        ? 403
        : code === "meta_rate_limited"
          ? 429
          : code === "account_unavailable"
            ? 409
            : 502,
      code,
    );
    this.providerCode = providerCode;
  }
}
const commentSchema = z.object({
  id: graphId,
  text: z.string().optional(),
  timestamp: z.string().optional(),
  hidden: z.boolean().optional(),
  parent_id: graphId.optional(),
  from: z
    .object({ id: graphId.optional(), username: z.string().optional() })
    .optional(),
  media: z.object({ id: graphId }).optional(),
});
export type Comment = z.infer<typeof commentSchema>;
const mediaFields =
  "id,owner,media_type,media_url,thumbnail_url,caption,permalink,timestamp,like_count,comments_count";
const commentFields = "id,text,timestamp,hidden,from,media,parent_id";
export function engagementMeta(
  fetcher: typeof fetch = fetch,
  base = "https://graph.instagram.com/v26.0",
) {
  async function call(
    path: string,
    token: string,
    method = "GET",
    params: Record<string, string> = {},
  ) {
    let res: Response, data: Record<string, unknown>;
    try {
      res = await fetcher(
        `${base}/${path}${method === "GET" ? `?${new URLSearchParams(params)}` : ""}`,
        {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(method !== "GET"
              ? { "Content-Type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(method !== "GET" ? { body: new URLSearchParams(params) } : {}),
        },
      );
      const reader = res.body?.getReader();
      if (!reader) throw Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 524288) {
            await reader.cancel();
            throw Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error();
    } catch {
      throw new EngagementError("meta_unavailable", true, method !== "GET");
    }
    if (!res.ok || data.error) {
      const err = data.error as
        | { code?: number; is_transient?: boolean }
        | undefined;
      const code = Number.isSafeInteger(err?.code) ? err!.code! : 0;
      const retry =
        res.status === 429 ||
        res.status >= 500 ||
        !!err?.is_transient ||
        [4, 17, 32, 613].includes(code);
      const error = new EngagementError(
        code === 190
          ? "account_unavailable"
          : res.status === 429 || [4, 17, 32, 613].includes(code)
            ? "meta_rate_limited"
            : [10, 200].includes(code) || res.status === 403
              ? "comments_permission_required"
              : "meta_rejected",
        retry,
        method !== "GET" && !(res.status >= 400 && res.status < 500 && !!err),
        code,
      );
      if (retry) {
        error.retryAfterSeconds = Math.min(
          3600,
          Math.max(60, Number(res.headers.get("retry-after")) || 60),
        );
        error.retryScope = method === "GET" ? "read" : "write_rejected";
        error.retrySource = "default";
      }
      throw error;
    }
    return data;
  }
  async function page(
    path: string,
    token: string,
    params: Record<string, string>,
    schema: z.ZodTypeAny,
  ) {
    const result = await call(path, token, "GET", params);
    const data = z.array(schema).max(50).safeParse(result.data);
    if (!data.success) throw new EngagementError("meta_invalid_response");
    const paging = result.paging as
      | { next?: unknown; cursors?: { after?: unknown } }
      | undefined;
    const after = paging?.cursors?.after;
    if (
      paging?.next &&
      (typeof after !== "string" || !after || after.length > 2048)
    )
      throw new EngagementError("meta_invalid_cursor");
    return {
      data: data.data,
      next_cursor: paging?.next ? (after as string) : null,
    };
  }
  async function media(account: string, id: string, token: string) {
    await insightsMeta(fetcher, base).media(account, id, token);
    const data = await call(id, token, "GET", { fields: mediaFields });
    if (data.id !== id) throw new EngagementError("meta_invalid_response");
    return Object.fromEntries(
      Object.entries(data).filter(([k]) => mediaFields.split(",").includes(k)),
    );
  }
  async function comment(mediaId: string, id: string, token: string) {
    const parsed = commentSchema.safeParse(
      await call(id, token, "GET", { fields: commentFields }),
    );
    if (!parsed.success) throw new EngagementError("meta_invalid_response");
    if (parsed.data.id !== id || parsed.data.media?.id !== mediaId)
      throw new ApiError(404, "comment_not_found");
    return parsed.data;
  }
  return {
    media,
    comment,
    async profile(account: string, token: string) {
      const raw = await call(account, token, "GET", {
        fields:
          "id,user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count",
      });
      return Object.fromEntries(
        Object.entries(raw).filter(([k]) =>
          [
            "id",
            "user_id",
            "username",
            "name",
            "account_type",
            "profile_picture_url",
            "followers_count",
            "follows_count",
            "media_count",
          ].includes(k),
        ),
      );
    },
    permissions: (token: string) =>
      page(
        "me/permissions",
        token,
        {},
        z.object({ permission: z.string(), status: z.string() }),
      ),
    subscriptions: (account: string, token: string) =>
      page(
        `${account}/subscribed_apps`,
        token,
        { fields: "id,subscribed_fields" },
        z.object({
          id: z.string().optional(),
          subscribed_fields: z.array(z.string()).optional(),
        }),
      ),
    publishingLimit: (account: string, token: string) =>
      call(`${account}/content_publishing_limit`, token, "GET", {
        fields: "config,quota_usage",
      }),
    async comments(
      mediaId: string,
      token: string,
      limit: number,
      after?: string,
    ) {
      return page(
        `${mediaId}/comments`,
        token,
        {
          fields: commentFields,
          limit: String(limit),
          ...(after ? { after } : {}),
        },
        commentSchema,
      ) as Promise<{ data: Comment[]; next_cursor: string | null }>;
    },
    async replies(id: string, token: string, limit: number, after?: string) {
      return page(
        `${id}/replies`,
        token,
        {
          fields: commentFields,
          limit: String(limit),
          ...(after ? { after } : {}),
        },
        commentSchema,
      ) as Promise<{ data: Comment[]; next_cursor: string | null }>;
    },
    children: (id: string, token: string, limit: number, after?: string) =>
      page(
        `${id}/children`,
        token,
        {
          fields: "id,media_type,media_url,thumbnail_url",
          limit: String(limit),
          ...(after ? { after } : {}),
        },
        z.object({
          id: graphId,
          media_type: z.string(),
          media_url: z.string().optional(),
          thumbnail_url: z.string().optional(),
        }),
      ),
    tags: (account: string, token: string, limit: number, after?: string) =>
      page(
        `${account}/tags`,
        token,
        {
          fields: "id,media_type,caption,permalink,timestamp",
          limit: String(limit),
          ...(after ? { after } : {}),
        },
        z.object({
          id: graphId,
          media_type: z.string().optional(),
          caption: z.string().optional(),
          permalink: z.string().optional(),
          timestamp: z.string().optional(),
        }),
      ),
    conversations: (
      account: string,
      token: string,
      limit: number,
      after?: string,
    ) =>
      page(
        `${account}/conversations`,
        token,
        {
          platform: "instagram",
          fields: "id,updated_time",
          limit: String(limit),
          ...(after ? { after } : {}),
        },
        z.object({
          id: z.string().min(1).max(1024),
          updated_time: z.string().optional(),
        }),
      ),
    async conversation(account: string, id: string, token: string) {
      const data = await call(encodeURIComponent(id), token, "GET", {
        fields: "id,participants",
      });
      const people = z
        .object({
          data: z
            .array(
              z.object({ id: z.string(), username: z.string().optional() }),
            )
            .max(10),
        })
        .safeParse(data.participants);
      if (!people.success || data.id !== id)
        throw new ApiError(404, "conversation_not_found");
      if (!people.data.data.some((x) => x.id === account)) {
        const me = await call("me", token, "GET", { fields: "id,user_id" });
        if (
          me.user_id !== account ||
          !people.data.data.some((x) => x.id === me.id)
        )
          throw new ApiError(404, "conversation_not_found");
      }
      return { id, participants: people.data.data };
    },
    async inboxMessages(
      conversation: string,
      token: string,
      limit: number,
      after?: string,
    ) {
      // The cursor is encoded as a quoted Graph field argument, never executable field syntax.
      const field = `messages.limit(${limit})${after ? `.after(${JSON.stringify(after)})` : ""}{id,created_time}`;
      const raw = await call(encodeURIComponent(conversation), token, "GET", {
        fields: field,
      });
      const parsed = z
        .object({
          data: z
            .array(
              z.object({
                id: z.string().min(1).max(1024),
                created_time: z.string().optional(),
              }),
            )
            .max(20),
          paging: z
            .object({
              next: z.string().optional(),
              cursors: z
                .object({ after: z.string().max(2048).optional() })
                .optional(),
            })
            .optional(),
        })
        .safeParse(raw.messages);
      if (!parsed.success) throw new EngagementError("meta_invalid_response");
      const messages = [];
      for (let i = 0; i < parsed.data.data.length; i += 5) {
        const parts = await Promise.all(
          parsed.data.data.slice(i, i + 5).map(async (item) => {
            try {
              const data = await call(
                encodeURIComponent(item.id),
                token,
                "GET",
                { fields: "id,created_time,from,to,message" },
              );
              if (data.id !== item.id)
                throw new EngagementError("meta_invalid_response");
              return {
                ...Object.fromEntries(
                  Object.entries(data).filter(([k]) =>
                    ["id", "created_time", "from", "to", "message"].includes(k),
                  ),
                ),
                details_available: true,
              };
            } catch (e) {
              return {
                ...item,
                details_available: false,
                error_code:
                  e instanceof ApiError ? e.message : "meta_unavailable",
              };
            }
          }),
        );
        messages.push(...parts);
      }
      const cursor = parsed.data.paging?.cursors?.after;
      if (parsed.data.paging?.next && !cursor)
        throw new EngagementError("meta_invalid_cursor");
      return {
        data: messages,
        next_cursor: parsed.data.paging?.next ? cursor! : null,
      };
    },
    async execute(a: Action, token: string) {
      let raw: Record<string, unknown>;
      switch (a.action) {
        case "comment.create":
          raw = await call(`${a.media_id}/comments`, token, "POST", {
            message: a.text,
          });
          break;
        case "comment.reply":
          raw = await call(`${a.comment_id}/replies`, token, "POST", {
            message: a.text,
          });
          break;
        case "comment.hide":
          raw = await call(a.comment_id, token, "POST", {
            hide: String(a.hidden),
          });
          break;
        case "comment.delete":
          raw = await call(a.comment_id, token, "DELETE");
          break;
        case "media.comments":
          raw = await call(a.media_id, token, "POST", {
            comment_enabled: String(a.enabled),
          });
          break;
      }
      if (a.action === "comment.create" || a.action === "comment.reply") {
        const id = graphId.safeParse(raw.id);
        if (!id.success)
          throw new EngagementError("meta_missing_id", false, true);
        return { external_id: id.data, acknowledged: true };
      }
      if (raw.success !== true)
        throw new EngagementError("meta_missing_success", false, true);
      return { acknowledged: true };
    },
    async commentsEnabled(id: string, token: string) {
      const data = await call(id, token, "GET", {
        fields: "id,is_comment_enabled",
      });
      if (typeof data.is_comment_enabled !== "boolean")
        throw new EngagementError("meta_invalid_response");
      return data.is_comment_enabled;
    },
  };
}
export type EngagementMeta = ReturnType<typeof engagementMeta>;
