import { prepareMaterial, listMaterials } from "@/lib/engagement/materials";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function POST(r:Request,c:Context) {return prepareMaterial((await c.params).id)(r);}
export async function GET(r:Request,c:Context) {return listMaterials((await c.params).id)(r);}
