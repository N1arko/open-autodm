import { z } from "zod";
import { ApiError, apiRoute, owner, respond } from "@/lib/transport/api";
import { defaultManagePorts, type ManagePorts } from "./manage";
import { account, token, type AdsAccount } from "./service";
import { metaId } from "./queries";
const after = z
  .string()
  .min(1)
  .max(2048)
  .refine((s) => !/[\r\n]/.test(s));
function query(request: Request, allowed: string[]) {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some(
      (k) => !allowed.includes(k) || params.getAll(k).length !== 1,
    )
  )
    throw new ApiError(400, "invalid_query");
  return params;
}
export const searchTargeting = (id: string, ports = defaultManagePorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      access = token(a, p),
      q = query(request, ["kind", "q", "country", "cursor"]);
    const parsed = z
      .object({
        kind: z.enum([
          "cities",
          "regions",
          "countries",
          "interests",
          "behaviors",
          "work_positions",
          "user_device",
          "user_os",
          "locales",
        ]),
        q: z.string().trim().min(1).max(200),
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        cursor: after.optional(),
      })
      .safeParse(Object.fromEntries(q.entries()));
    if (!parsed.success) throw new ApiError(400, "invalid_query");
    const v = parsed.data;
    const geo = ["cities", "regions", "countries"].includes(v.kind);
    const locationType: Record<string, string> = {
      cities: "city",
      regions: "region",
      countries: "country",
    };
    const params = geo
      ? {
          type: "adgeolocation",
          q: v.q,
          location_types: [locationType[v.kind]],
          limit: 50,
          ...(v.country ? { country_code: v.country } : {}),
          ...(v.cursor ? { after: v.cursor } : {}),
        }
      : {
          q: v.q,
          whitelisted_types: [v.kind],
          limit: 50,
          ...(v.country ? { countries: [v.country] } : {}),
          ...(v.cursor ? { after: v.cursor } : {}),
        };
    const result = await p.writer.targetingSearch(
      a.ad_account_id,
      access,
      params,
      geo,
    );
    return respond({
      ...result,
      cached: false,
      fetched_at: new Date().toISOString(),
    });
  });
async function authorizedPage(
  a: AdsAccount,
  page: string,
  proof: string | null,
  p: ManagePorts,
) {
  const access = token(a, p);
  if (proof) {
    if (!metaId.safeParse(proof).success)
      throw new ApiError(400, "invalid_query");
    const c = await p.writer.creative(a.ad_account_id, proof, access);
    const spec = c.object_story_spec as { page_id?: string } | undefined;
    if (spec?.page_id === page || c.object_story_id?.split("_")[0] === page)
      return;
    throw new ApiError(404, "page_account_not_linked");
  }
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const result = await p.writer.assets(
      a.ad_account_id,
      access,
      "pages",
      cursor,
    );
    if (result.data.some((row) => "id" in row && row.id === page)) return;
    if (!result.next_cursor) break;
    if (result.next_cursor === cursor)
      throw new ApiError(502, "meta_invalid_response");
    cursor = result.next_cursor;
  }
  throw new ApiError(404, "page_account_not_linked");
}
export const getPageInstagram = (
  id: string,
  pageId: string,
  media = false,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      q = query(request, media ? ["creative_id", "cursor"] : ["creative_id"]);
    if (
      !metaId.safeParse(pageId).success ||
      (q.has("cursor") && !after.safeParse(q.get("cursor")).success)
    )
      throw new ApiError(400, "invalid_query");
    await authorizedPage(a, pageId, q.get("creative_id"), p);
    const access = token(a, p),
      page = await p.writer.pageInstagram(pageId, access);
    const instagramId =
      page.instagram_business_account?.id ??
      page.connected_instagram_account?.id;
    if (!instagramId)
      return respond({
        page,
        instagram: null,
        discovery: "no_link_returned",
        cached: false,
        fetched_at: new Date().toISOString(),
      });
    const result = await p.writer.instagram(
      instagramId,
      access,
      media,
      q.get("cursor") ?? undefined,
    );
    return respond({
      page,
      instagram_id: instagramId,
      ...(media ? result : { instagram: result }),
      cached: false,
      fetched_at: new Date().toISOString(),
    });
  });
export const getCreative = (
  id: string,
  creativeId: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    query(request, []);
    if (!metaId.safeParse(creativeId).success)
      throw new ApiError(400, "invalid_meta_id");
    return respond({
      creative: await p.writer.creative(
        a.ad_account_id,
        creativeId,
        token(a, p),
      ),
      cached: false,
      fetched_at: new Date().toISOString(),
    });
  });
