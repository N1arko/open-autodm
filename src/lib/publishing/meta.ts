export class PublishingMetaError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public uncertain = false,
  ) {
    super(code);
  }
}
// Publishing can take longer than a metadata read. Keep it inside the worker lease.
export const PUBLISH_TIMEOUT_MS = 60_000;
export interface PublishingMeta {
  create(
    account: string,
    video: string,
    caption: string,
    feed: boolean,
    token: string,
    cover?: string,
  ): Promise<string>;
  status(container: string, token: string): Promise<string>;
  publish(account: string, container: string, token: string): Promise<string>;
  permalink(media: string, token: string): Promise<string>;
}
/** Instagram Login user tokens use graph.instagram.com. URLs and tokens never enter logs. */
export function publishingMeta(
  fetcher: typeof fetch = fetch,
  base = "https://graph.instagram.com/v26.0",
): PublishingMeta {
  async function call(
    path: string,
    token: string,
    input?: Record<string, string>,
    publishing = false,
  ) {
    let response: Response;
    try {
      response = await fetcher(`${base}/${path}`, {
        method: input ? "POST" : "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(publishing ? PUBLISH_TIMEOUT_MS : 20_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(input
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
        ...(input ? { body: new URLSearchParams(input) } : {}),
      });
    } catch {
      throw new PublishingMetaError("meta_connection_failed", true, publishing);
    }
    let data: Record<string, unknown>;
    try {
      // Graph responses are small. Bound unknown provider output as well as timeout.
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
    } catch {
      throw new PublishingMetaError("meta_invalid_response", true, publishing);
    }
    if (!response.ok || data.error) {
      const error = data.error as
        { code?: number; is_transient?: boolean } | undefined;
      const code = Number.isInteger(error?.code) ? error!.code : 0;
      const rejected =
        response.status >= 400 && response.status < 500 && !!error;
      throw new PublishingMetaError(
        `meta_http_${response.status}_code_${code}`,
        response.status === 429 ||
          response.status >= 500 ||
          !!error?.is_transient ||
          [4, 17, 32, 613].includes(code!),
        publishing && !rejected,
      );
    }
    return data;
  }
  const id = (data: Record<string, unknown>, publishing = false) => {
    if (typeof data.id !== "string" || !/^\d+$/.test(data.id))
      throw new PublishingMetaError("meta_missing_id", true, publishing);
    return data.id;
  };
  return {
    async create(account, video, caption, feed, token, cover) {
      return id(
        await call(`${account}/media`, token, {
          media_type: "REELS",
          video_url: video,
          caption,
          share_to_feed: String(feed),
          ...(cover ? { cover_url: cover } : {}),
        }),
      );
    },
    async status(container, token) {
      const data = await call(`${container}?fields=status_code`, token);
      if (typeof data.status_code !== "string")
        throw new PublishingMetaError("meta_missing_status", true);
      return data.status_code;
    },
    async publish(account, container, token) {
      return id(
        await call(
          `${account}/media_publish`,
          token,
          { creation_id: container },
          true,
        ),
        true,
      );
    },
    async permalink(media, token) {
      const data = await call(`${media}?fields=permalink`, token);
      if (typeof data.permalink !== "string")
        throw new PublishingMetaError("meta_missing_permalink", true);
      const url = new URL(data.permalink);
      if (
        url.protocol !== "https:" ||
        !["instagram.com", "www.instagram.com"].includes(url.hostname)
      )
        throw new PublishingMetaError("meta_invalid_permalink", false);
      return data.permalink;
    },
  };
}
