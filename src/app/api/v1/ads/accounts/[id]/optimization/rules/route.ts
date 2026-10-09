import { listRules, setRule } from "@/lib/ads/optimization";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return listRules(id)(request);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return setRule((await context.params).id, null)(request);
}
