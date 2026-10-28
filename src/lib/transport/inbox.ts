import { z } from "zod";
import { hash, readBody, ApiError } from "./api";
import { hmacSha256Hex, safeCompare } from "@/lib/crypto";
import { transportStore } from "./store";
const id = z.string().min(1).max(2048);
const actor = z.object({ id }).passthrough();
const messaging = z
  .object({
    sender: actor,
    recipient: actor,
    timestamp: z.number().finite().positive().max(8640000000000000),
    message: z
      .object({
        mid: id,
        text: z.string().max(20000).optional(),
        is_echo: z.boolean().optional(),
        quick_reply: z.object({ payload: z.string() }).passthrough().optional(),
        reply_to: z
          .object({ story: z.object({ id }).passthrough().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    postback: z
      .object({ payload: z.string(), title: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const change = z.object({field:z.string(),value:z.unknown()}).passthrough();
export function normalizeWebhook(value: unknown): unknown {
 if(!value || typeof value!=="object" || !("entry" in value) || !Array.isArray(value.entry))return value;
 return {...value,entry:value.entry.map((e: unknown)=>{
  if(!e || typeof e!=="object")return e;
  const entry=e as Record<string,unknown>;
  const changes=Array.isArray(entry.changes)?entry.changes:typeof entry.field==="string"?[{field:entry.field,value:entry.value}]:undefined;
  return {...entry,...(changes?{changes:changes.map((c:unknown)=>{
   if(!c || typeof c!=="object")return c;
   const change=c as Record<string,unknown>,v=change.value;
   if(v && typeof v==="object" && "comment_id" in v && !("id" in v))return {...change,value:{...v,id:v.comment_id}};
   return change;
  })}:{})};
 })};
}
export const webhookSchema = z
  .object({
    object: z.enum(["instagram", "page"]),
    entry: z
      .array(
        z
          .object({
            id,
            time: z.number().finite(),
            messaging: z.array(messaging).max(1000).optional(),
            changes: z.array(change).max(1000).optional(),
          })
          .passthrough(),
      )
      .max(1000),
  })
  .passthrough();
export async function persistWebhook(rawBody: string) {
  const body = webhookSchema.parse(normalizeWebhook(JSON.parse(rawBody)));
  return transportStore.rpc<string>("transport_store_webhook", {
    p_hash: hash(rawBody),
    p_body: body,
  });
}
export async function routeBotDm(
  account: string,
  sender: string,
  mid: string,
  text: string,
  timestamp: number,
) {
  return transportStore.rpc<"unbound" | "received" | "duplicate">(
    "transport_ingest_dm",
    {
      p_account: account,
      p_sender: sender,
      p_mid: mid,
      p_text: text,
      p_occurred: new Date(timestamp).toISOString(),
    },
  );
}

export async function receiveWebhook(
  request: Request,
  secrets: string[],
  persist = persistWebhook,
): Promise<Response> {
  let raw: string;
  try {
    raw = await readBody(request, 1024 * 1024);
  } catch (e) {
    return Response.json(
      { error: "Invalid body" },
      { status: e instanceof ApiError ? e.status : 400 },
    );
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (
    !secrets.some((s) =>
      safeCompare(signature, `sha256=${hmacSha256Hex(s, raw)}`),
    )
  )
    return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    await persist(raw);
  } catch (e) {
    const invalid =
      e instanceof SyntaxError || (e instanceof Error && e.name === "ZodError");
    return Response.json(
      { error: invalid ? "Invalid payload" : "Persistence unavailable" },
      { status: invalid ? 400 : 503 },
    );
  }
  return Response.json({ status: "ok" }, { status: 200 });
}
