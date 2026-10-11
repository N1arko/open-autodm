import { z } from "zod";
import { metaId } from "./queries";

export const imageHash = z.string().regex(/^[a-f0-9]{32}$/i);
const text = z.string().trim().min(1).max(1000);
const enroll = z.enum(["OPT_IN", "OPT_OUT"]);
const cropPoint = z.tuple([
  z.number().int().min(0).max(12000),
  z.number().int().min(0).max(12000),
]);
const crop = z
  .tuple([cropPoint, cropPoint])
  .refine(
    (v) => v[0][0] < v[1][0] && v[0][1] < v[1][1],
    "invalid_crop_rectangle",
  );
export const imageCrops = z
  .object(
    Object.fromEntries(
      [
        "100x100",
        "100x72",
        "191x100",
        "300x400",
        "400x150",
        "400x500",
        "600x360",
        "90x160",
      ].map((k) => [k, crop.optional()]),
    ) as Record<string, z.ZodOptional<typeof crop>>,
  )
  .strict()
  .refine((v) => Object.keys(v).length > 0, "empty_crops");
const feature = z
  .object({
    enroll_status: enroll,
    customizations: z
      .object({
        text_extraction: z
          .object({ enroll_status: enroll })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const featureNames = [
  "advantage_plus_creative",
  "cv_transformation",
  "enhance_cta",
  "image_animation",
  "image_brightness_and_contrast",
  "image_templates",
  "image_touchups",
  "inline_comment",
  "show_destination_blurbs",
  "text_optimizations",
  "text_generation",
  "music_generation",
  "image_auto_crop",
  "image_uncrop",
  "image_background_gen",
  "image_enhancement",
  "video_auto_crop",
  "video_uncrop",
] as const;
export const featuresInput = z
  .object(
    Object.fromEntries(
      featureNames.map((key) => [key, feature.optional()]),
    ) as Record<(typeof featureNames)[number], z.ZodOptional<typeof feature>>,
  )
  .strict()
  .refine(
    (v) => Object.keys(v).length > 0,
    "explicit_feature_selection_required",
  );
export const creativeControls = {
  degrees_of_freedom_spec: z
    .object({ creative_features_spec: featuresInput })
    .strict()
    .optional(),
  contextual_multi_ads: z.object({ enroll_status: enroll }).strict().optional(),
  media_sourcing_spec: z
    .object({
      source_creative_id: metaId.optional(),
      images: z
        .array(
          z
            .object({
              hash: imageHash,
              source: z.enum([
                "multi_media",
                "padding",
                "uncrop",
                "recomposition",
              ]),
              opt_in_status: z.enum(["opt_in", "opt_out"]),
              variant_types: z
                .array(
                  z.enum([
                    "SQUARE",
                    "HORIZONTAL",
                    "VERTICAL",
                    "FULLSCREEN_VERTICAL",
                  ]),
                )
                .min(1)
                .max(4)
                .optional(),
            })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict()
    .optional(),
};
export const manualMessage = z
  .object({
    greeting: text,
    questions: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(80),
            response: z.string().trim().min(1).max(1000).nullable(),
          })
          .strict(),
      )
      .max(4),
    ai_generated_icebreakers: z.literal(false).default(false),
  })
  .strict();
export const templateRef = z
  .object({ id: z.string().uuid(), version: z.number().int().positive() })
  .strict();
export function welcomeMessage(input: z.infer<typeof manualMessage>) {
  return JSON.stringify({
    type: "VISUAL_EDITOR",
    version: 2,
    landing_screen_type: "welcome_message",
    media_type: "text",
    text_format: {
      customer_action_type: "ice_breakers",
      message: {
        text: input.greeting,
        ice_breakers: input.questions,
        quick_replies: [],
      },
    },
    user_edit: true,
    surface: "visual_editor_new",
    welcome_message_edited: true,
    ice_breakers_edited: true,
    ai_generated_icebreaker_toggle_enabled: false,
    has_ai_generated_welcome_message: false,
    performance_booster_enabled: false,
  });
}
const labels = z
  .array(
    z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
  )
  .min(1)
  .max(10);
const positions = z
  .array(z.string().regex(/^[a-z_]{1,50}$/))
  .min(1)
  .max(20);
const label = z
  .object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) })
  .strict();
export const placementInput = z
  .object({
    facebook_positions: positions.optional(),
    instagram_positions: positions.optional(),
    messenger_positions: positions.optional(),
    audience_network_positions: positions.optional(),
  })
  .strict();
export const assetFeed = z
  .object({
    images: z
      .array(
        z
          .object({
            hash: imageHash,
            adlabels: labels,
            image_crops: imageCrops.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    videos: z
      .array(
        z
          .object({
            video_id: metaId,
            adlabels: labels,
            thumbnail_hash: imageHash.optional(),
            thumbnail_url: z
              .string()
              .url()
              .max(2048)
              .refine(
                (s) =>
                  new URL(s).protocol === "https:" &&
                  !new URL(s).username &&
                  !new URL(s).password,
              )
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
    bodies: z
      .array(z.object({ text: z.string().min(1).max(10000) }).strict())
      .min(1)
      .max(5),
    titles: z.array(z.object({ text }).strict()).max(5).optional(),
    link_urls: z
      .array(
        z
          .object({
            website_url: z
              .string()
              .url()
              .max(2048)
              .refine(
                (s) =>
                  new URL(s).protocol === "https:" &&
                  !new URL(s).username &&
                  !new URL(s).password,
              ),
          })
          .strict(),
      )
      .min(1)
      .max(5)
      .optional(),
    call_to_action_types: z
      .array(
        z.enum([
          "LEARN_MORE",
          "SHOP_NOW",
          "SIGN_UP",
          "LISTEN_NOW",
          "INSTAGRAM_MESSAGE",
          "BOOK_NOW",
          "CONTACT_US",
          "DOWNLOAD",
          "GET_QUOTE",
        ]),
      )
      .min(1)
      .max(1),
    ad_formats: z.array(z.enum(["SINGLE_IMAGE", "SINGLE_VIDEO"])).length(1),
    optimization_type: z.enum(["PLACEMENT", "DEGREES_OF_FREEDOM"]),
    asset_customization_rules: z
      .array(
        z
          .object({
            customization_spec: z
              .object({
                ...placementInput.shape,
                publisher_platforms: z
                  .array(
                    z.enum([
                      "facebook",
                      "instagram",
                      "messenger",
                      "audience_network",
                    ]),
                  )
                  .min(1)
                  .max(4),
                device_platforms: z
                  .array(z.enum(["mobile", "desktop"]))
                  .min(1)
                  .max(2)
                  .optional(),
              })
              .strict(),
            image_label: label.optional(),
            video_label: label.optional(),
            is_default: z.boolean().optional(),
            priority: z.number().int().min(1).max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !!v.images === !!v.videos ||
      (v.images && v.ad_formats[0] !== "SINGLE_IMAGE") ||
      (v.videos && v.ad_formats[0] !== "SINGLE_VIDEO")
    )
      ctx.addIssue({ code: "custom", message: "asset_media_format_mismatch" });
    const names = (v.images ?? v.videos ?? []).flatMap((m) =>
      m.adlabels.map((l) => l.name),
    );
    const mediaValues =
      v.images?.map((m) => m.hash) ?? v.videos?.map((m) => m.video_id) ?? [];
    if (new Set(mediaValues).size !== mediaValues.length)
      ctx.addIssue({ code: "custom", message: "duplicate_media_asset" });
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "duplicate_asset_label" });
    for (const rule of v.asset_customization_rules) {
      const chosen = v.images ? rule.image_label : rule.video_label;
      if (
        !chosen ||
        !names.includes(chosen.name) ||
        (v.images ? rule.video_label : rule.image_label)
      )
        ctx.addIssue({
          code: "custom",
          message: "invalid_asset_label_reference",
        });
    }
  });

export const directCreative = z
  .object({
    kind: z.literal("instagram_direct"),
    page_id: metaId,
    instagram_user_id: metaId,
    instagram_legacy_id: metaId,
    adset_id: metaId,
    media: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("image"), image_hash: imageHash }).strict(),
      z
        .object({
          kind: z.literal("video"),
          video_id: metaId,
          thumbnail_hash: imageHash,
        })
        .strict(),
    ]),
    message: z.string().min(1).max(10000),
    title: text.optional(),
    welcome: manualMessage.optional(),
    template: templateRef.optional(),
    // The owner must choose a policy; omitting it must not re-enable a provider default.
    degrees_of_freedom_spec: z
      .object({ creative_features_spec: featuresInput })
      .strict(),
    contextual_multi_ads: z.object({ enroll_status: enroll }).strict(),
    asset_feed_spec: assetFeed.optional(),
    media_sourcing_spec: creativeControls.media_sourcing_spec,
  })
  .strict();

export function directParams(c: z.infer<typeof directCreative>) {
  if (!c.welcome) throw new Error("direct_template_not_resolved");
  const call_to_action = {
    type: "INSTAGRAM_MESSAGE",
    value: {
      app_destination: "INSTAGRAM_DIRECT",
      app_link: `instagram://direct?userid=${c.instagram_legacy_id}`,
    },
  };
  return {
    object_story_spec: {
      page_id: c.page_id,
      instagram_user_id: c.instagram_user_id,
      ...(c.asset_feed_spec
        ? {}
        : c.media.kind === "image"
          ? {
              link_data: {
                image_hash: c.media.image_hash,
                link: "https://www.instagram.com/",
                message: c.message,
                ...(c.title ? { name: c.title } : {}),
                call_to_action,
              },
            }
          : {
              video_data: {
                video_id: c.media.video_id,
                image_hash: c.media.thumbnail_hash,
                message: c.message,
                ...(c.title ? { title: c.title } : {}),
                call_to_action,
              },
            }),
    },
    page_welcome_message: welcomeMessage(c.welcome),
    degrees_of_freedom_spec: c.degrees_of_freedom_spec,
    contextual_multi_ads: c.contextual_multi_ads,
    ...(c.asset_feed_spec
      ? {
          asset_feed_spec: {
            ...c.asset_feed_spec,
            link_urls: [{ website_url: "https://www.instagram.com/" }],
            call_to_actions: [call_to_action],
            ...(c.asset_feed_spec.videos
              ? {
                  videos: c.asset_feed_spec.videos.map((v, i) => ({
                    ...v,
                    ...(i === 0 && c.media.kind === "video"
                      ? { thumbnail_hash: c.media.thumbnail_hash }
                      : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(c.media_sourcing_spec
      ? { media_sourcing_spec: { images: c.media_sourcing_spec.images } }
      : {}),
  };
}
