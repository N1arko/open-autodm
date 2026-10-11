import { z } from "zod";
import {
  ApiError,
  apiRoute,
  jsonBody,
  owner,
  respond,
} from "@/lib/transport/api";
import { account, type AdsAccount, type AdsPorts } from "./service";
import { defaultManagePorts } from "./manage";
import { manualMessage } from "./creative";
const uuid = z.string().uuid();
export interface ChatTemplate {
  id: string;
  account_id: string;
  name: string;
  version: number;
  selected_version: number;
  archived: boolean;
  body: z.infer<typeof manualMessage>;
}
export async function templateVersion(
  a: AdsAccount,
  id: string,
  version: number,
  p: AdsPorts,
) {
  const row = await p.store.rpc<ChatTemplate | null>("ads_templates", {
    p_user: a.user_id,
    p_account: a.id,
    p_id: id,
    p_version: version,
  });
  if (
    !row ||
    row.account_id !== a.id ||
    row.id !== id ||
    row.selected_version !== version
  )
    throw new ApiError(404, "template_not_found");
  const parsed = manualMessage.safeParse(row.body);
  if (!parsed.success) throw new ApiError(409, "template_invalid");
  return { id: row.id, version, body: parsed.data };
}
export const readTemplates = (
  id: string,
  templateId?: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p),
      q = new URL(request.url).searchParams;
    if (
      [...q.keys()].some((k) => !["version", "cursor"].includes(k)) ||
      [...q.keys()].some((k) => q.getAll(k).length !== 1) ||
      (templateId && !uuid.safeParse(templateId).success) ||
      (q.has("cursor") && !uuid.safeParse(q.get("cursor")).success) ||
      (q.has("version") &&
        (!templateId || !/^[1-9]\d{0,3}$/.test(q.get("version")!)))
    )
      throw new ApiError(400, "invalid_query");
    const result = await p.store.rpc("ads_templates", {
      p_user: a.user_id,
      p_account: a.id,
      p_id: templateId ?? null,
      p_version: q.has("version") ? Number(q.get("version")) : null,
      p_cursor: q.get("cursor"),
    });
    if (!result) throw new ApiError(404, "template_not_found");
    return respond(result);
  });
export const saveTemplate = (
  id: string,
  templateId?: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    if (templateId && !uuid.safeParse(templateId).success)
      throw new ApiError(404, "not_found");
    const input = await jsonBody(
      request,
      z
        .object({
          name: z.string().trim().min(1).max(200),
          body: manualMessage,
          expected_version: z.number().int().positive().optional(),
        })
        .strict(),
    );
    if (!!templateId !== !!input.expected_version)
      throw new ApiError(400, "expected_version_required_for_update");
    return respond(
      await p.store.rpc("ads_template_save", {
        p_user: a.user_id,
        p_account: a.id,
        p_id: templateId ?? null,
        p_expected: input.expected_version ?? null,
        p_name: input.name,
        p_body: input.body,
        p_archived: false,
      }),
      templateId ? 200 : 201,
    );
  });
export const archiveTemplate = (
  id: string,
  templateId: string,
  ports = defaultManagePorts,
) =>
  apiRoute(async (request) => {
    const p = ports(),
      a = await account(await owner(request), id, p);
    if (!uuid.safeParse(templateId).success)
      throw new ApiError(404, "not_found");
    const body = await jsonBody(
      request,
      z.object({ expected_version: z.number().int().positive() }).strict(),
    );
    return respond(
      await p.store.rpc("ads_template_save", {
        p_user: a.user_id,
        p_account: a.id,
        p_id: templateId,
        p_expected: body.expected_version,
        p_name: null,
        p_body: null,
        p_archived: true,
      }),
    );
  });
