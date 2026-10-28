import { z } from "zod";
import { ApiError } from "@/lib/transport/api";
export const graphId = z.string().regex(/^\d{1,30}$/);
export const text = z.string().trim().min(1).max(2200);
export const actionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("comment.create"), media_id: graphId, text })
    .strict(),
  z
    .object({
      action: z.literal("comment.reply"),
      media_id: graphId,
      comment_id: graphId,
      text,
    })
    .strict(),
  z
    .object({
      action: z.literal("comment.hide"),
      media_id: graphId,
      comment_id: graphId,
      hidden: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("comment.delete"),
      media_id: graphId,
      comment_id: graphId,
    })
    .strict(),
  z
    .object({
      action: z.literal("media.comments"),
      media_id: graphId,
      enabled: z.boolean(),
    })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export function pagination(params: URLSearchParams) {
  const limit = Number(params.get("limit") ?? 25),
    after = params.get("after");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (after !== null && (!after || after.length > 2048))
  )
    throw new ApiError(400, "invalid_pagination");
  return { limit, ...(after ? { after } : {}) };
}
export const validId = (id: string) => {
  if (!graphId.safeParse(id).success)
    throw new ApiError(400, "invalid_graph_id");
  return id;
};
export const idempotency = (request: Request) => {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
    throw new ApiError(400, "idempotency_key_required");
  return key;
};
