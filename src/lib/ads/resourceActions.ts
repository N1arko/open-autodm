import { z } from "zod";
import { metaId } from "./queries";

const name = z.string().trim().min(1).max(200);
const description = z.string().max(2000);
const https = z
  .string()
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  });
// Rules/filters are Meta expressions, not executable code. Bound their size/depth.
export const expression = z.record(z.unknown()).superRefine((v, ctx) => {
  function depth(x: unknown, n = 0): boolean {
    if (n > 12) return false;
    if (x && typeof x === "object")
      return Object.values(x).every((s) => depth(s, n + 1));
    return true;
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 8192 || !depth(v))
    ctx.addIssue({ code: "custom", message: "expression_too_large" });
});
const productFields = {
  name,
  description,
  image_url: https,
  url: https,
  currency: z.string().regex(/^[A-Z]{3}$/),
  price: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  availability: z.enum([
    "in stock",
    "out of stock",
    "preorder",
    "available for order",
    "discontinued",
  ]),
  condition: z.enum(["new", "refurbished", "used"]),
  brand: name,
  inventory: z.number().int().min(0).max(1000000000).optional(),
};
const update = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).partial().strict();
export const resourceOptions = [
  z
    .object({
      action: z.literal("pixel.create"),
      params: z.object({ name }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("pixel.update"),
      object_id: metaId,
      params: z.object({ name }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("audience.create"),
      params: z
        .object({
          name,
          description: description.optional(),
          subtype: z.enum([
            "CUSTOM",
            "WEBSITE",
            "LOOKALIKE",
            "ENGAGEMENT",
            "VIDEO",
          ]),
          pixel_id: metaId.optional(),
          origin_audience_id: metaId.optional(),
          rule: expression.optional(),
          retention_days: z.number().int().min(1).max(180).optional(),
          customer_file_source: z
            .enum([
              "USER_PROVIDED_ONLY",
              "PARTNER_PROVIDED_ONLY",
              "BOTH_USER_AND_PARTNER_PROVIDED",
            ])
            .optional(),
          lookalike_spec: z
            .object({
              country: z.string().regex(/^[A-Z]{2}$/),
              ratio: z.number().min(0.01).max(0.2),
              type: z.literal("similarity").default("similarity"),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("audience.update"),
      object_id: metaId,
      params: update({
        name,
        description,
        retention_days: z.number().int().min(1).max(180),
      }),
    })
    .strict(),
  z
    .object({
      action: z.literal("audience.users.add"),
      object_id: metaId,
      params: z
        .object({
          data_use_authorized: z.literal(true),
          payload: z
            .object({
              schema: z
                .array(z.enum(["EMAIL", "PHONE"]))
                .min(1)
                .max(2)
                .refine((v) => new Set(v).size === v.length),
              data: z
                .array(
                  z
                    .array(z.string().regex(/^[a-f0-9]{64}$/))
                    .min(1)
                    .max(2),
                )
                .min(1)
                .max(40),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("catalog.create"),
      params: z
        .object({
          business_id: metaId,
          name,
          vertical: z.literal("commerce").default("commerce"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("catalog.update"),
      object_id: metaId,
      params: z.object({ business_id: metaId, name }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("product.create"),
      params: z
        .object({
          business_id: metaId,
          catalog_id: metaId,
          retailer_id: name,
          ...productFields,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("product.update"),
      object_id: metaId,
      params: z
        .object({
          business_id: metaId,
          catalog_id: metaId,
          ...update(productFields).shape,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("productset.create"),
      params: z
        .object({
          business_id: metaId,
          catalog_id: metaId,
          name,
          filter: expression,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("productset.update"),
      object_id: metaId,
      params: z
        .object({
          business_id: metaId,
          catalog_id: metaId,
          ...update({ name, filter: expression }).shape,
        })
        .strict(),
    })
    .strict(),
] as const;
export const resourceInput = z.discriminatedUnion("action", [
  ...resourceOptions,
]);
export type ResourceAction = z.infer<typeof resourceInput>;
export const isResource = (a: { action: string }): a is ResourceAction =>
  /^(pixel|audience|catalog|product|productset)\./.test(a.action);
export type ResourceKind =
  | "pixels"
  | "audiences"
  | "catalogs"
  | "products"
  | "productsets";
export function resourcePath(account: string, a: ResourceAction) {
  if (a.action === "audience.users.add") return `${a.object_id}/users`;
  if ("object_id" in a) return a.object_id;
  if (a.action === "catalog.create")
    return `${a.params.business_id}/owned_product_catalogs`;
  if (a.action === "product.create") return `${a.params.catalog_id}/products`;
  if (a.action === "productset.create")
    return `${a.params.catalog_id}/product_sets`;
  return `act_${account}/${a.action === "pixel.create" ? "adspixels" : "customaudiences"}`;
}
export function resourceParams(a: ResourceAction): Record<string, unknown> {
  const p = { ...a.params } as Record<string, unknown>;
  delete p.data_use_authorized;
  delete p.business_id;
  delete p.catalog_id;
  return p;
}
