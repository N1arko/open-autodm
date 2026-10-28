import {validateAction} from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(r:Request,c:{params:Promise<{id:string}>}) {return validateAction((await c.params).id)(r);}
