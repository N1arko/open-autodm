import { z } from "zod";
import {
  ApiError,
  apiRoute,
  jsonBody,
  owner,
  respond,
} from "@/lib/transport/api";
import { transportStore } from "@/lib/transport/store";
import {
  accessToken,
  collect,
  defaultInsightsPorts,
  ownedAccount,
  settings,
  usable,
  type InsightsPorts,
} from "./service";
import {
  accountQuery,
  audienceQuery,
  mediaId,
  metrics,
  MEDIA_METRICS,
  range,
  refresh,
  utcDay,
  DAY,
} from "./queries";

export const getAccountInsights = (id: string, ports = defaultInsightsPorts) =>
  apiRoute(async (request) => {
    const a = await ownedAccount(await owner(request), id),
      params = new URL(request.url).searchParams;
    return respond(
      await collect(
        a,
        a.instagram_user_id,
        accountQuery(params),
        ports(),
        refresh(params),
      ),
    );
  });
export const getMediaInsights = (
  id: string,
  media: string,
  ports = defaultInsightsPorts,
) =>
  apiRoute(async (request) => {
    const a = await ownedAccount(await owner(request), id),
      params = new URL(request.url).searchParams;
    const target = mediaId(media);
    return respond(
      await collect(
        a,
        target,
        { kind: "media", metrics: metrics(params, MEDIA_METRICS) },
        ports(),
        refresh(params),
      ),
    );
  });
export const getAudienceInsights = (id: string, ports = defaultInsightsPorts) =>
  apiRoute(async (request) => {
    const a = await ownedAccount(await owner(request), id),
      params = new URL(request.url).searchParams;
    return respond(
      await collect(
        a,
        a.instagram_user_id,
        audienceQuery(params),
        ports(),
        refresh(params),
      ),
    );
  });
export const listAccountMedia = (
  id: string,
  ports: () => InsightsPorts = defaultInsightsPorts,
) =>
  apiRoute(async (request) => {
    const a = await ownedAccount(await owner(request), id);
    usable(a);
    const params = new URL(request.url).searchParams,
      limit = Number(params.get("limit") ?? 25),
      after = params.get("after");
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (after !== null && (!after || after.length > 2048))
    )
      throw new ApiError(400, "invalid_pagination");
    const p = ports();
    return respond(
      await p.meta.list(
        a.instagram_user_id,
        accessToken(a, p),
        limit,
        after ?? undefined,
      ),
    );
  });
export const getInsightsSettings = (id: string) =>
  apiRoute(async (request) =>
    respond(await settings(await ownedAccount(await owner(request), id))),
  );
export const setInsightsSettings = (id: string) =>
  apiRoute(async (request) => {
    const a = await ownedAccount(await owner(request), id);
    const input = await jsonBody(
      request,
      z
        .object({
          enabled: z.boolean(),
          media_limit: z.number().int().min(0).max(50).default(10),
          retention_days: z.number().int().min(30).max(730).default(90),
        })
        .strict(),
    );
    if (input.enabled) usable(a);
    return respond(
      await transportStore.rpc("insights_configure", {
        p_user: a.user_id,
        p_account: a.id,
        p_enabled: input.enabled,
        p_limit: input.media_limit,
        p_retention: input.retention_days,
      }),
    );
  });
export const getInsightsHistory = (id: string) =>
  apiRoute(async (request) => {
    const a = await ownedAccount(await owner(request), id),
      params = new URL(request.url).searchParams;
    const kind = params.get("kind"),
      target = params.get("media_id"),
      cursor = params.get("cursor");
    if (
      (kind !== null && !["account", "media", "audience"].includes(kind)) ||
      (cursor !== null && !z.string().uuid().safeParse(cursor).success)
    )
      throw new ApiError(400, "invalid_history_query");
    if (target !== null) mediaId(target);
    if (!params.has("to")) params.set("to", utcDay(Date.now() + DAY));
    const window = range(params, Date.now(), 730);
    return respond(
      await transportStore.rpc("insights_history", {
        p_user: a.user_id,
        p_account: a.id,
        p_kind: kind,
        p_target: target,
        p_from: window.from,
        p_to: window.to,
        p_cursor: cursor,
      }),
    );
  });
