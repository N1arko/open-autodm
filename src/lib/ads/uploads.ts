import { createHash } from "node:crypto";
import { decrypt, encrypt } from "@/lib/crypto";
import { ApiError, apiRoute, owner, respond } from "@/lib/transport/api";
import { account, token, type AdsAccount, type AdsPorts } from "./service";
import { defaultManagePorts } from "./manage";

const MAX = 8 * 1024 * 1024;
export function imageMetadata(bytes: Buffer) {
  let width = 0,
    height = 0,
    mime = "";
  if (
    bytes.length >= 45 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND"
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    mime = "image/png";
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  ) {
    for (let i = 2; i + 4 < bytes.length; ) {
      if (bytes[i++] !== 255) break;
      while (bytes[i] === 255) i++;
      const marker = bytes[i++]!;
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = bytes.readUInt16BE(i + 3);
        width = bytes.readUInt16BE(i + 5);
        mime = "image/jpeg";
        break;
      }
      i += length;
    }
  }
  if (
    !mime ||
    width < 1 ||
    height < 1 ||
    width > 12000 ||
    height > 12000 ||
    width * height > 50000000
  )
    throw new ApiError(400, "invalid_image");
  return {
    width,
    height,
    mime,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
interface Staged {
  id: string;
  account_id: string;
  metadata: ReturnType<typeof imageMetadata> & { name: string };
  expires_at: string;
  bytes_encrypted: string;
}
export async function stagedImage(a: AdsAccount, upload: string, p: AdsPorts) {
  const row = await p.store.rpc<Staged | null>("ads_image_staged", {
    p_user: a.user_id,
    p_account: a.id,
    p_upload: upload,
  });
  if (
    !row ||
    row.account_id !== a.id ||
    row.id !== upload ||
    Date.parse(row.expires_at) <= Date.now()
  )
    throw new ApiError(404, "image_upload_expired_or_not_found");
  return row;
}
export function imageBytes(row: Staged, p: AdsPorts) {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(
      decrypt(row.bytes_encrypted, p.encryptionKey),
      "base64",
    );
  } catch {
    throw new ApiError(409, "image_upload_unavailable");
  }
  if (bytes.length > MAX || imageMetadata(bytes).sha256 !== row.metadata.sha256)
    throw new ApiError(409, "image_upload_changed");
  return bytes.toString("base64");
}
export const stageImage = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    token(a, p);
    if (!a.management_enabled)
      throw new ApiError(409, "ads_management_disabled");
    const contentType = request.headers.get("content-type") ?? "";
    if (
      !contentType.startsWith("multipart/form-data;") ||
      contentType.length > 300
    )
      throw new ApiError(415, "multipart_required");
    const max = MAX + 65536;
    if (Number(request.headers.get("content-length") ?? 0) > max)
      throw new ApiError(413, "body_too_large");
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError(400, "body_required");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
          await reader.cancel();
          throw new ApiError(413, "body_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let form: FormData;
    try {
      form = await new Response(Buffer.concat(chunks), {
        headers: { "Content-Type": contentType },
      }).formData();
    } catch {
      throw new ApiError(400, "invalid_multipart");
    }
    const entries = [...form.entries()],
      file = form.get("file");
    if (
      entries.length !== 1 ||
      !(file instanceof File) ||
      !file.size ||
      file.size > MAX
    )
      throw new ApiError(400, "one_image_file_required");
    const bytes = Buffer.from(await file.arrayBuffer()),
      metadata = imageMetadata(bytes);
    const name =
      file.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 200) || "image";
    const row = await p.store.rpc<Omit<Staged, "bytes_encrypted">>(
      "ads_image_stage",
      {
        p_user: a.user_id,
        p_account: a.id,
        p_metadata: { ...metadata, name },
        p_bytes: encrypt(bytes.toString("base64"), p.encryptionKey),
      },
    );
    return respond(
      {
        ...row,
        state: "staged",
        meta_uploaded: false,
        eligibility: "requires_meta_upload_and_creative_validation",
      },
      201,
    );
  });
