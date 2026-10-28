import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import { ownedAccount } from "@/lib/insights/service";
import { transportStore } from "@/lib/transport/store";
import {
  ApiError,
  apiRoute,
  owner,
  jsonBody,
  respond,
  hash,
} from "@/lib/transport/api";
import { idempotency } from "./input";
const bucket = () => createServiceClient().storage.from("instagram-materials");
interface Material {
  id: string;
  account_id: string;
  object_path: string;
  mime: string;
  size: number;
  status: string;
  created_at: string;
}
async function material(user: string, id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(400, "invalid_id");
  const { data, error } = await createServiceClient()
    .from("instagram_materials")
    .select("id,account_id,object_path,mime,size,status,created_at")
    .eq("user_id", user)
    .eq("id", id)
    .maybeSingle();
  if (error) throw Error("db_unavailable");
  if (!data) throw new ApiError(404, "not_found");
  return data as Material;
}
const visible = (m: Material) => ({
  id: m.id,
  account_id: m.account_id,
  mime: m.mime,
  size: m.size,
  status: m.status,
  created_at: m.created_at,
});
export const prepareMaterial = (account: string) =>
  apiRoute(async (request) => {
    const user = await owner(request),
      key = idempotency(request);
    await ownedAccount(user, account);
    const input = await jsonBody(
      request,
      z
        .object({
          mime: z.enum(["image/jpeg", "video/mp4", "video/quicktime"]),
          size: z
            .number()
            .int()
            .min(1)
            .max(300 * 1024 * 1024),
        })
        .strict(),
    );
    if (input.mime === "image/jpeg" && input.size > 8 * 1024 * 1024)
      throw new ApiError(400, "image_too_large");
    const m = await transportStore.rpc<Material>("instagram_material_prepare", {
      p_user: user,
      p_account: account,
      p_mime: input.mime,
      p_size: input.size,
      p_key: key,
      p_hash: hash(JSON.stringify({ account_id: account, ...input })),
    });
    if (m.status === "ready") return respond(visible(m));
    const { data, error } = await bucket().createSignedUploadUrl(
      m.object_path,
      { upsert: false },
    );
    if (error) throw new ApiError(502, "storage_upload_unavailable");
    return respond(
      {
        ...visible(m),
        upload_url: data.signedUrl,
        upload_method: "PUT",
        upload_content_type: m.mime,
        upload_expires_in: 7200,
      },
      201,
    );
  });
export const completeMaterial = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request),
      m = await material(user, id),
      b = bucket();
    const { data, error } = await b.info(m.object_path);
    if (error) throw new ApiError(409, "upload_not_available");
    if (data.size !== Number(m.size) || data.contentType !== m.mime)
      throw new ApiError(409, "upload_metadata_mismatch");
    const { error: updateError } = await createServiceClient()
      .from("instagram_materials")
      .update({ status: "ready" })
      .eq("id", id)
      .eq("user_id", user);
    if (updateError) throw Error("db_unavailable");
    return respond({ ...visible(m), status: "ready" });
  });
export const materialUrl = (id: string) =>
  apiRoute(async (request) => {
    const m = await material(await owner(request), id);
    if (m.status !== "ready") throw new ApiError(409, "upload_not_ready");
    const ttl = Number(
      new URL(request.url).searchParams.get("expires_in") ?? 604800,
    );
    if (!Number.isInteger(ttl) || ttl < 3600 || ttl > 604800)
      throw new ApiError(400, "invalid_expiry");
    const { data, error } = await bucket().createSignedUrl(m.object_path, ttl);
    if (error) throw new ApiError(502, "storage_url_unavailable");
    return respond({
      ...visible(m),
      url: data.signedUrl,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  });
export const listMaterials = (id: string) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    await ownedAccount(user, id);
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor && !z.string().uuid().safeParse(cursor).success)
      throw new ApiError(400, "invalid_cursor");
    let q = createServiceClient()
      .from("instagram_materials")
      .select("id,account_id,mime,size,status,created_at")
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
