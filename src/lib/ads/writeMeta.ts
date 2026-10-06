import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
import { metaId } from "./queries";
import { actionEdge, paramsFor, type Action } from "./actions";

export class WriteMetaError extends ApiError {
  constructor(
    code: string,
    public uncertain = false,
    public providerCode = 0,
    public providerSubcode = 0,
  ) {
    super(
      code === "ads_permission_required"
        ? 403
        : code === "ads_token_unavailable"
          ? 409
          : code === "meta_rate_limited"
            ? 429
            : 502,
      code,
    );
  }
}
const objectSchema = z.object({
  id: metaId,
  account_id: metaId,
  campaign_id: metaId.optional(),
  adset_id: metaId.optional(),
  status: z.string().max(100).optional(),
  name: z.string().max(1000).optional(),
  daily_budget: z.string().max(30).regex(/^\d+$/).optional(),
  lifetime_budget: z.string().max(30).regex(/^\d+$/).optional(),
  budget_remaining: z.string().max(30).regex(/^\d+$/).optional(),
  updated_time: z.string().max(100).optional(),
  start_time: z.string().max(100).optional(),
  end_time: z.string().max(100).optional(),
  targeting: z.record(z.unknown()).optional(),
  creative: z.object({ id: metaId }).optional(),
  objective: z.string().max(100).optional(),
  optimization_goal: z.string().max(100).optional(),
  object_type: z.string().max(100).optional(),
});
export type MetaObject = z.infer<typeof objectSchema>;
export function writeMeta(
  fetcher: typeof fetch = fetch,
  base = "https://graph.facebook.com/v26.0",
  deadline = Infinity,
) {
  async function call(
    path: string,
    token: string,
    params: Record<string, unknown>,
    post = false,
  ) {
    if (
      !/^(act_)?\d{1,30}(\/(campaigns|adsets|ads|adcreatives|advideos|adimages|promote_pages|instagram_accounts))?$/.test(
        path,
      )
    )
      throw new ApiError(400, "invalid_meta_path");
    const form = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]),
    );
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new WriteMetaError("meta_unavailable");
    let r: Response, data: Record<string, unknown>;
    try {
      r = await fetcher(`${base}/${path}${post ? "" : `?${form}`}`, {
        method: post ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(post
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(post ? { body: form } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(12000, remaining)),
      });
      const reader = r.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        (r.status >= 300 && r.status < 400)
      )
        throw new Error();
    } catch {
      throw new WriteMetaError("meta_unavailable", post);
    }
    if (!r.ok || data.error) {
      const e = data.error as
          | { code?: number; error_subcode?: number }
          | undefined,
        code = Number(e?.code ?? 0),
        sub = Number(e?.error_subcode ?? 0);
      throw new WriteMetaError(
        r.status >= 500
          ? "meta_unavailable"
          : code === 190
            ? "ads_token_unavailable"
            : [10, 200, 294].includes(code) || r.status === 403
              ? "ads_permission_required"
              : [4, 17, 32, 613, 80000, 80004].includes(code) ||
                  r.status === 429
                ? "meta_rate_limited"
                : "meta_rejected",
        post && r.status >= 500,
        code,
        sub,
      );
    }
    return data;
  }
  const id = (s: string) => {
    if (!metaId.safeParse(s).success)
      throw new ApiError(400, "invalid_meta_id");
    return s;
  };
  const accountObject = (
    value: unknown,
    account: string,
    expected?: string,
  ) => {
    const p = objectSchema.safeParse(value);
    if (
      !p.success ||
      p.data.account_id !== account ||
      (expected && p.data.id !== expected)
    )
      throw new ApiError(404, "ads_object_not_found");
    return p.data;
  };
  return {
    async object(account: string, object: string, kind: string, token: string) {
      const fields =
        kind === "campaign"
          ? "id,account_id,name,status,objective,daily_budget,lifetime_budget,updated_time"
          : kind === "adset"
            ? "id,account_id,name,status,campaign_id,optimization_goal,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,targeting,updated_time"
            : kind === "ad"
              ? "id,account_id,name,status,campaign_id,adset_id,creative{id},updated_time"
              : "id,account_id,name,object_type";
      const result = accountObject(
        await call(id(object), token, { fields }),
        account,
        object,
      );
      if (
        (kind === "campaign" && !result.objective) ||
        (kind === "adset" &&
          (!result.campaign_id || !result.optimization_goal)) ||
        (kind === "ad" &&
          (!result.adset_id || !result.campaign_id || !result.creative)) ||
        (kind === "creative" && !result.object_type)
      )
        throw new ApiError(404, "ads_object_not_found");
      return result;
    },
    async adsets(account: string, campaign: string, token: string) {
      const result: MetaObject[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const data = await call(`${id(campaign)}/adsets`, token, {
          fields:
            "id,account_id,status,campaign_id,daily_budget,lifetime_budget,budget_remaining,end_time,updated_time",
          limit: "50",
          ...(after ? { after } : {}),
        });
        if (!Array.isArray(data.data) || data.data.length > 50)
          throw new WriteMetaError("meta_invalid_response");
        for (const row of data.data) {
          const p = accountObject(row, account);
          if (p.campaign_id !== campaign)
            throw new WriteMetaError("meta_invalid_response");
          result.push(p);
        }
        const paging = data.paging as
          | { next?: unknown; cursors?: { after?: unknown } }
          | undefined;
        if (!paging?.next)
          return result.sort((a, b) => a.id.localeCompare(b.id));
        const cursor = paging.cursors?.after;
        if (
          typeof cursor !== "string" ||
          !cursor ||
          cursor.length > 2048 ||
          /[\r\n]/.test(cursor) ||
          cursor === after
        )
          throw new WriteMetaError("meta_invalid_response");
        after = cursor;
      }
      throw new ApiError(409, "campaign_too_large");
    },
    async assets(
      account: string,
      token: string,
      kind: "pages" | "images" | "videos" | "instagram",
      after?: string,
    ) {
      const edge = {
        pages: "promote_pages",
        images: "adimages",
        videos: "advideos",
        instagram: "instagram_accounts",
      }[kind];
      const data = await call(`act_${id(account)}/${edge}`, token, {
        fields:
          kind === "images"
            ? "hash,name"
            : kind === "videos"
              ? "id,title,status"
              : kind === "instagram"
                ? "id,username"
                : "id,name",
        limit: "50",
        ...(after ? { after } : {}),
      });
      const schema =
        kind === "images"
          ? z.object({
              hash: z.string().regex(/^[a-f0-9]{32}$/i),
              name: z.string().max(1000).optional(),
            })
          : kind === "videos"
            ? z.object({
                id: metaId,
                title: z.string().max(1000).optional(),
                status: z
                  .object({ video_status: z.string().max(100) })
                  .optional(),
              })
            : z.object({
                id: metaId,
                name: z.string().max(1000).optional(),
                username: z.string().max(1000).optional(),
              });
      const parsed = z.array(schema).max(50).safeParse(data.data);
      if (!parsed.success) throw new WriteMetaError("meta_invalid_response");
      const paging = data.paging as
          | { next?: unknown; cursors?: { after?: unknown } }
          | undefined,
        cursor = paging?.cursors?.after;
      if (
        paging?.next &&
        (typeof cursor !== "string" ||
          !cursor ||
          cursor.length > 2048 ||
          /[\r\n]/.test(cursor))
      )
        throw new WriteMetaError("meta_invalid_response");
      return {
        data: parsed.data,
        next_cursor: paging?.next ? (cursor as string) : null,
      };
    },
    async mutate(account: string, token: string, a: Action, validate = false) {
      if (validate && a.action === "video.upload")
        throw new ApiError(400, "video_validation_unavailable");
      const path =
        "object_id" in a
          ? id(a.object_id)
          : `act_${id(account)}/${actionEdge[a.action]}`;
      const data = await call(
        path,
        token,
        {
          ...paramsFor(a),
          ...(validate ? { execution_options: ["validate_only"] } : {}),
        },
        true,
      );
      if (validate) {
        if (data.success !== true)
          throw new WriteMetaError("meta_invalid_validation_response");
        return { validated: true };
      }
      if ("object_id" in a) {
        if (data.success !== true)
          throw new WriteMetaError("meta_invalid_response", true);
        return { object_id: a.object_id, success: true };
      }
      const parsed = metaId.safeParse(data.id);
      if (!parsed.success)
        throw new WriteMetaError("meta_invalid_response", true);
      return { object_id: parsed.data, success: true };
    },
  };
}
export type Writer = ReturnType<typeof writeMeta>;
