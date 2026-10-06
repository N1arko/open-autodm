import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import {
  ApiError,
  apiRoute,
  hash,
  owner,
  readBody,
  respond,
} from "@/lib/transport/api";
import { transportStore } from "@/lib/transport/store";
import { validateVideoUrl } from "./url";
export { validateVideoUrl } from "./url";

export const publicationSchema = z
  .object({
    account_id: z.string().uuid(),
    video_url: z.string().url().max(4096),
    cover_url: z.string().url().max(4096).optional(),
    caption: z
      .string()
      .refine((s) => Array.from(s).length <= 2200)
      .default(""),
    share_to_feed: z.boolean().default(true),
    publish_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const visible =
  "id,account_id,video_url,cover_url,caption,share_to_feed,publish_at,status,container_id,media_id,permalink,error_code,attempts,created_at,updated_at,published_at";
export function publicPublication(row: Record<string, unknown>) {
  return Object.fromEntries(visible.split(",").map((k) => [k, row[k]]));
}
async function rpc<T>(name: string, args: Record<string, unknown>) {
  try {
    return await transportStore.rpc<T>(name, args);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (["account_unavailable", "cannot_cancel"].includes(code))
      throw new ApiError(409, code);
    throw error;
  }
}
export const createPublication = apiRoute(async (request) => {
  const user = await owner(request);
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
    throw new ApiError(400, "idempotency_key_required");
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(415, "json_required");
  let data: unknown;
  try {
    data = JSON.parse(await readBody(request, 16384));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json");
  }
  const parsed = publicationSchema.safeParse(data);
  if (!parsed.success) throw new ApiError(400, "invalid_body");
  const input = parsed.data;
  const at = input.publish_at ? new Date(input.publish_at).toISOString() : null;
  if (at && Date.parse(at) > Date.now() + 366 * 86400_000)
    throw new ApiError(400, "schedule_too_far");
  // Replays must still return the original result after a signed video URL expires.
  const requestHash = hash(JSON.stringify({ ...input, publish_at: at }));
  const db = createServiceClient();
  const { data: existing, error } = await db
    .from("instagram_publications")
    .select("id,request_hash")
    .eq("user_id", user)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw new Error("db_unavailable");
  if (!existing) {
    try {
      await validateVideoUrl(input.video_url);
    } catch {
      throw new ApiError(400, "invalid_video_url");
    }
    if (input.cover_url) {
      try {
        await validateVideoUrl(input.cover_url);
      } catch {
        throw new ApiError(400, "invalid_cover_url");
      }
    }
  }
  const row = await rpc<Record<string, unknown>>("publishing_enqueue", {
    p_user: user,
    p_account: input.account_id,
    p_url: input.video_url,
    p_caption: input.caption,
    p_feed: input.share_to_feed,
    p_at: at,
    p_key: key,
    p_hash: requestHash,
    p_cover: input.cover_url ?? null,
  });
  return respond(publicPublication(row), 202);
});
export const listPublications = apiRoute(async (request) => {
  const user = await owner(request);
  const url = new URL(request.url),
    cursor = url.searchParams.get("cursor"),
    account = url.searchParams.get("account_id");
  if (cursor && !z.string().uuid().safeParse(cursor).success)
    throw new ApiError(400, "invalid_cursor");
  if (account && !z.string().uuid().safeParse(account).success)
    throw new ApiError(400, "invalid_account");
  let query = createServiceClient()
    .from("instagram_publications")
    .select(visible)
    .eq("user_id", user)
    .order("id")
    .limit(51);
  if (cursor) query = query.gt("id", cursor);
  if (account) query = query.eq("account_id", account);
  const { data, error } = await query;
  if (error) throw new Error("db_unavailable");
  return respond({
    data: data.slice(0, 50),
    next_cursor: data.length > 50 ? data[49]!.id : null,
  });
});
export const getPublication = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    if (!z.string().uuid().safeParse(id).success)
      throw new ApiError(400, "invalid_id");
    const { data, error } = await createServiceClient()
      .from("instagram_publications")
      .select(visible)
      .eq("id", id)
      .eq("user_id", user)
      .maybeSingle();
    if (error) throw new Error("db_unavailable");
    if (!data) throw new ApiError(404, "not_found");
    return respond(data);
  });
export const cancelPublication = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    if (!z.string().uuid().safeParse(id).success)
      throw new ApiError(400, "invalid_id");
    return respond(
      publicPublication(
        await rpc("publishing_cancel", { p_user: user, p_id: id }),
      ),
    );
  });
