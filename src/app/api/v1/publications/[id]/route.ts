import { getPublication, cancelPublication, editPublication } from "@/lib/publishing/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return getPublication((await context.params).id)(request);
}
export async function DELETE(request: Request, context: Context) {
  return cancelPublication((await context.params).id)(request);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return editPublication((await context.params).id)(request);
}
