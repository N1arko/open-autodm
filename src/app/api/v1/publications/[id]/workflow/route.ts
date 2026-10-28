import { publicationWorkflow } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(r:Request,c:{params:Promise<{id:string}>}) {return publicationWorkflow((await c.params).id)(r);}
