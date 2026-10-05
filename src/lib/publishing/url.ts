import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { publicAddress } from "@/lib/transport/http";

/** The service sends this URL to Meta; it never proxies/downloads the video. */
export async function validateVideoUrl(value: string) {
  const url = new URL(value),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("invalid_video_url");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new Error("invalid_video_url");
}
