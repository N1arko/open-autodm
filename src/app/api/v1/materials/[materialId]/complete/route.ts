import { completeMaterial } from "@/lib/engagement/materials";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{materialId:string}>};
export async function POST(r:Request,c:Context) {return completeMaterial((await c.params).materialId)(r);}
