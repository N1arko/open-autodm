import { z } from "zod";
import {
  ApiError,
  apiRoute,
  jsonBody,
  owner,
  respond,
} from "@/lib/transport/api";
import {
  accountInput,
  collectionQuery,
  forceRefresh,
  insightQuery,
  tokenInput,
  type Collection,
} from "./queries";
import {
  account,
  ciphertext,
  defaultAdsPorts,
  read,
  verify,
  visible,
} from "./service";

export const connectAdsAccount = (ports = defaultAdsPorts) =>
  apiRoute(async (request) => {
    const user = await owner(request);
    const input = await jsonBody(
      request,
      z
        .object({ ad_account_id: accountInput, access_token: tokenInput })
        .strict(),
    );
    const p = ports(),
      metadata = await verify(input.ad_account_id, input.access_token, p);
    const row = await p.store.rpc("ads_connect", {
      p_user: user,
      p_meta_id: input.ad_account_id,
      p_token: ciphertext(input.access_token, p),
      p_metadata: metadata,
    });
    return respond(
      { account: row, capabilities: { read: true, manage: false } },
      201,
    );
  });
export const listAdsAccounts = (ports = defaultAdsPorts) =>
  apiRoute(async (request) => {
    const user = await owner(request),
      params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((v) => v !== "cursor") ||
      params.getAll("cursor").length > 1
    )
      throw new ApiError(400, "invalid_query");
    const cursor = params.get("cursor");
    if (cursor !== null && !z.string().uuid().safeParse(cursor).success)
      throw new ApiError(400, "invalid_cursor");
    return respond(
      await ports().store.rpc("ads_accounts", {
        p_user: user,
        p_cursor: cursor,
      }),
    );
  });
export const getAdsAccount = (id: string, ports = defaultAdsPorts) =>
  apiRoute(async (request) =>
    respond(visible(await account(await owner(request), id, ports()))),
  );
export const updateAdsAccount = (id: string, ports = defaultAdsPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    const input = await jsonBody(
      request,
      z.object({ enabled: z.boolean() }).strict(),
    );
    return respond(
      await p.store.rpc("ads_update", {
        p_user: a.user_id,
        p_account: a.id,
        p_enabled: input.enabled,
      }),
    );
  });
export const rotateAdsToken = (id: string, ports = defaultAdsPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    const input = await jsonBody(
      request,
      z.object({ access_token: tokenInput }).strict(),
    );
    const metadata = await verify(a.ad_account_id, input.access_token, p);
    return respond(
      await p.store.rpc("ads_rotate", {
        p_user: a.user_id,
        p_account: a.id,
        p_token: ciphertext(input.access_token, p),
        p_metadata: metadata,
      }),
    );
  });
export const listAdsObjects = (
  id: string,
  kind: Collection,
  ports = defaultAdsPorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      params = new URL(request.url).searchParams;
    const query = collectionQuery(params),
      refresh = forceRefresh(params);
    return respond(await read(a, kind, query, p, refresh));
  });
export const getAdsInsights = (id: string, ports = defaultAdsPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      params = new URL(request.url).searchParams;
    const query = insightQuery(params, a.metadata.timezone_name),
      refresh = forceRefresh(params);
    return respond(await read(a, "insights", query, p, refresh));
  });
export const getAdsStatus = (id: string, ports = defaultAdsPorts) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((v) => v !== "refresh") ||
      params.getAll("refresh").length > 1
    )
      throw new ApiError(400, "invalid_query");
    return respond(await read(a, "status", {}, p, forceRefresh(params)));
  });
