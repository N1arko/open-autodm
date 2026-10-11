import { z } from "zod";
import { metaId } from "./queries";

function clean(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("provider_data_too_deep");
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") {
    if (value.length > 32768) throw new Error("provider_string_too_large");
    if (/^(EAA[A-Za-z0-9]{80,}|adm_[a-f0-9]{64}|bot_[a-f0-9]{64})$/.test(value))
      return "[redacted]";
    if (/^\s*[\[{]/.test(value)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        /* Ordinary creative copy remains text. */
      }
      if (parsed && typeof parsed === "object")
        return JSON.stringify(clean(parsed, depth + 1));
    }
    return value.replace(/([?&]access_token=)[^&\s]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error("provider_array_too_large");
    return value.map((v) => clean(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 200) throw new Error("provider_object_too_large");
    return Object.fromEntries(
      entries
        .filter(
          ([key]) =>
            !/^(access_token|token|secret|password|authorization|appsecret_proof|__proto__|constructor|prototype)$/i.test(
              key,
            ),
        )
        .map(([key, val]) => [key, clean(val, depth + 1)]),
    );
  }
  throw new Error("invalid_provider_value");
}
export const providerJson = z.unknown().transform((value, ctx) => {
  try {
    if (JSON.stringify(value).length > 65536) throw new Error();
    return clean(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid_provider_json" });
    return z.NEVER;
  }
});
export const creativeRead = z.object({
  id: metaId,
  account_id: metaId.optional(),
  name: z.string().max(1000).optional(),
  title: z.string().max(1000).optional(),
  body: z.string().max(10000).optional(),
  object_type: z.string().max(100).optional(),
  object_story_id: z.string().max(100).optional(),
  effective_object_story_id: z.string().max(100).optional(),
  instagram_user_id: metaId.optional(),
  source_instagram_media_id: metaId.optional(),
  effective_instagram_media_id: metaId.optional(),
  object_story_spec: providerJson.optional(),
  asset_feed_spec: providerJson.optional(),
  call_to_action: providerJson.optional(),
  degrees_of_freedom_spec: providerJson.optional(),
  contextual_multi_ads: providerJson.optional(),
  platform_customizations: providerJson.optional(),
  image_crops: providerJson.optional(),
  destination_spec: providerJson.optional(),
  creative_sourcing_spec: providerJson.optional(),
  media_sourcing_spec: providerJson.optional(),
  page_welcome_message: z.string().max(32768).pipe(providerJson).optional(),
});
export const CREATIVE_FIELDS =
  "id,account_id,name,title,body,object_type,object_story_id,effective_object_story_id,instagram_user_id,source_instagram_media_id,effective_instagram_media_id,object_story_spec,asset_feed_spec,call_to_action,degrees_of_freedom_spec,contextual_multi_ads,platform_customizations,image_crops,destination_spec,creative_sourcing_spec,media_sourcing_spec,page_welcome_message";
