import type { ProviderDetails } from "@/lib/transport/api";

/** Bounded plain text for the owner; never expose provider URLs or credentials. */
export function providerDetails(
  value: unknown,
  token: string,
): ProviderDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const error = value as Record<string, unknown>;
  function clean(input: unknown) {
    if (typeof input !== "string") return;
    let text = input.slice(0, 16000);
    if (token) text = text.split(token).join("[redacted]");
    text = text
      .replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"']+/gi, "[url removed]")
      .replace(
        /\b(?:Bearer\s+\S+|(?:adm|bot)_[a-f\d]{32,}|EAA[a-z\d]{20,}|eyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+)\b/gi,
        "[redacted]",
      )
      .replace(
        /\b(?:access[_-]?token|app[_-]?secret|client[_-]?secret|password|authorization|api[_-]?key)["']?\s*[=:]\s*["']?[^\s,;<>]+/gi,
        "[redacted]",
      )
      .replace(/<[^>]*>/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
    return text || undefined;
  }
  const result = {
    message: clean(error.message),
    user_title: clean(error.error_user_title),
    user_message: clean(error.error_user_msg),
  };
  return Object.values(result).some(Boolean) ? result : undefined;
}
