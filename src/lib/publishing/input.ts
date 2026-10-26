import { z } from "zod";

const mediaUrl = z.string().url().max(4096);
export const publicationItemSchema = z.object({
  media_type: z.enum(["IMAGE", "VIDEO"]),
  url: mediaUrl,
}).strict();
export type PublicationItem = z.infer<typeof publicationItemSchema>;

export const publicationSchema = z.object({
  account_id: z.string().uuid(),
  video_url: mediaUrl.optional(),
  cover_url: mediaUrl.optional(),
  caption: z.string().refine((s) => Array.from(s).length <= 2200).default(""),
  share_to_feed: z.boolean().default(true),
  publish_at: z.string().datetime({ offset: true }).optional(),
  media_type: z.enum(["REELS", "CAROUSEL", "STORIES"]).optional(),
  image_url: mediaUrl.optional(),
  items: z.array(publicationItemSchema).min(2).max(20).optional(),
}).strict().superRefine((p, ctx) => {
  const kind = p.media_type ?? "REELS";
  const invalid = kind === "REELS"
    ? !p.video_url || !!p.image_url || !!p.items
    : kind === "CAROUSEL"
      ? !p.items || !!p.video_url || !!p.image_url || !!p.cover_url
      : Number(!!p.video_url) + Number(!!p.image_url) !== 1 ||
        !!p.items || !!p.cover_url || p.caption !== "";
  if (invalid) ctx.addIssue({ code: "custom", message: "Invalid media fields for publication type" });
});

/** Keep the original Reel request hash stable across the schema upgrade. */
export function publicationHashInput(input: z.infer<typeof publicationSchema>, at: string | null) {
  const { media_type, ...data } = input;
  return JSON.stringify({ ...data, publish_at: at,
    ...(media_type && media_type !== "REELS" ? { media_type } : {}),
  });
}
