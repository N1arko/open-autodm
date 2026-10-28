import { reconcileOperation } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{operationId:string}>};
export async function POST(request: Request, context: Context) {
 const p=await context.params;
 return reconcileOperation(p.operationId)(request);
}
