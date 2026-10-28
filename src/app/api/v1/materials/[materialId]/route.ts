import { materialUrl } from "@/lib/engagement/materials";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{materialId:string}>};
export async function GET(r:Request,c:Context) {return materialUrl((await c.params).materialId)(r);}
