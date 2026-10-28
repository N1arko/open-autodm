import { capabilities } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function GET(request: Request, context: Context) {
 const p=await context.params;
 return capabilities(p.id)(request);
}
