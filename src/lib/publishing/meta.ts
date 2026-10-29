import type { PublicationItem, TrialParams } from "./input";
import { providerDetails, type ProviderDetails } from "./diagnostics";

export interface PublishingProviderError {
  http_status: number;
  code: number;
  subcode?: number;
  details?: ProviderDetails;
}

export class PublishingMetaError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public uncertain = false,
    public providerError?: PublishingProviderError,
  ) {
    super(code);
  }
}
// Publishing can take longer than a metadata read. Keep it inside the worker lease.
export const PUBLISH_TIMEOUT_MS = 60_000;
export type PublishingOptions = { alt_text?: string; thumb_offset?: number; is_ai_generated?: boolean; trial_params?: TrialParams };
export interface PublishingMeta {
  create(
    account: string,
    video: string,
    caption: string,
    feed: boolean,
    token: string,
    cover?: string,
    options?: PublishingOptions,
  ): Promise<string>;
  createImage(account: string, image: string, caption: string, token: string, options?: PublishingOptions): Promise<string>;
  createItem(account: string, item: PublicationItem, token: string): Promise<string>;
  createCarousel(account: string, children: string[], caption: string, token: string, options?: PublishingOptions): Promise<string>;
  createStory(account: string, source: { video_url?: string; image_url?: string }, token: string, options?: PublishingOptions): Promise<string>;
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
        { code?: number; error_subcode?: number; is_transient?: boolean } | undefined;
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
        { http_status: response.status, code: code!,
          ...(Number.isInteger(error?.error_subcode) ? { subcode: error!.error_subcode } : {}),
          details: providerDetails(error, token) },
      );
    }
    return data;
  }
  const id = (data: Record<string, unknown>, publishing = false) => {
    if (typeof data.id !== "string" || !/^\d+$/.test(data.id))
      throw new PublishingMetaError("meta_missing_id", true, publishing);
    return data.id;
  };
  const optionsForm = (o: PublishingOptions = {}) => Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v === "object" ? JSON.stringify(v) : String(v)]));
  return {
    async createImage(account, image, caption, token, options) {
      return id(await call(`${account}/media`, token, { image_url: image, caption, ...optionsForm(options) }));
    },
    async createItem(account, item, token) {
      return id(await call(`${account}/media`, token, {
        is_carousel_item: "true",
        ...(item.alt_text !== undefined ? { alt_text: item.alt_text } : {}),
        ...(item.media_type === "VIDEO"
          ? { media_type: "VIDEO", video_url: item.url }
          : { image_url: item.url }),
      }));
    },
    async createCarousel(account, children, caption, token, options) {
      return id(await call(`${account}/media`, token, {
        media_type: "CAROUSEL", children: children.join(","), caption, ...optionsForm(options),
      }));
    },
    async createStory(account, source, token, options) {
      return id(await call(`${account}/media`, token, {
        media_type: "STORIES", ...source, ...optionsForm(options),
      }));
    },
    async create(account, video, caption, feed, token, cover, options) {
      return id(
        await call(`${account}/media`, token, {
          ...optionsForm(options),
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
