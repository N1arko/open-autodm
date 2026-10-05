export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export {
  createPublication as POST,
  listPublications as GET,
} from "@/lib/publishing/api";
