/**
 * HTTP-клиент к webhook IN API Crosslybot.
 *
 * Stateless — экземпляр на session, конфигурируется slug + token + опционально
 * HMAC secret при handshake. Все методы — тонкие обёртки над POST/GET endpoint'ами
 * wh.crosslybot.ru с автоматической подписью если secret предоставлен.
 *
 * Дополнительные защиты webhook'а (require_signature, require_timestamp) включаются
 * пользователем в карточке webhook IN. Если включены — нужен HMAC secret.
 *
 * Forced coupling backend: при require_signature=true backend форсит
 * require_timestamp=true, так что наличие secret подразумевает что timestamp
 * тоже нужно слать.
 */

import { createHmac } from "node:crypto";

const DEFAULT_BASE_URL = "https://wh.crosslybot.ru";

export interface WebhookInfoTarget {
  id: string;
  platform: string;
  name: string | null;
  paused_until: string | null;
}

export interface WebhookInfoProject {
  index: number;
  name: string | null;
  paused_until: string | null;
  targets: WebhookInfoTarget[];
}

export interface WebhookInfoCapabilities {
  entity_types: string[];
  media_types: string[];
  limits: {
    max_text_length: number;
    max_media: number;
    max_buttons_rows: number;
    max_buttons_per_row: number;
    max_payload_bytes: number;
    max_pause_minutes: number;
  };
}

export interface WebhookInfoResponse {
  endpoint: { slug: string | null; name: string | null; verbose: boolean };
  projects: WebhookInfoProject[];
  capabilities: WebhookInfoCapabilities;
}

export interface MediaItem {
  type: "photo" | "video" | "audio";
  url: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface PublishPayload {
  text?: string;
  media?: MediaItem[];
  targets?: { id: string }[];
  is_advertisement?: boolean;
  ad_pause_minutes?: number;
  ad_target_pause_minutes?: number;
  external_id?: string;
  trace_id?: string;
  metadata?: Record<string, unknown>;
}

export interface PublishResponse {
  ok: boolean;
  delivery_id: string;
  request_id: string;
  post_ids: number[];
}

export class CrosslybotApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CrosslybotApiError";
  }
}

/**
 * Формирует user-friendly сообщение для LLM (показывается в MCP tool result
 * как `isError: true`). Цель — чтобы Claude мог понять что не так и подсказать
 * пользователю как исправить.
 *
 * Структура: «Краткое описание + конкретная ошибка + действие».
 */
export function formatApiError(err: CrosslybotApiError): string {
  const body = err.body;
  const bodyObj = (body && typeof body === "object" ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
  const apiError = typeof bodyObj.error === "string" ? bodyObj.error : null;
  const errorCode = typeof bodyObj.error_code === "string" ? bodyObj.error_code : null;
  const retryAfter = typeof bodyObj.retry_after_seconds === "number" ? bodyObj.retry_after_seconds : null;

  switch (err.status) {
    case 401:
      return (
        "Ошибка аутентификации (401). Возможные причины:\n" +
        "  • Токен невалиден или был ротирован в UI Crosslybot. Перевыпустите в карточке webhook IN.\n" +
        "  • Slug в URL не существует или отозван.\n" +
        "  • IP MCP-сервера (89.223.125.61) не в allowlist endpoint'а — добавьте его в Безопасность.\n" +
        "  • При require_timestamp=true: timestamp вне окна ±5 мин (часы сервера расходятся).\n" +
        "  • При require_signature=true: HMAC secret не передан в `X-Crosslybot-Hmac-Secret` header или невалиден.\n" +
        (apiError ? `\nBackend: ${apiError}` : "")
      );
    case 403:
      return (
        "Доступ запрещён (403). " +
        (apiError ?? "Возможно тариф не позволяет эту операцию.") +
        "\n  • Webhook IN требует тариф Pro/Maxi/Business.\n" +
        "  • Отложенная пауза требует Pro+.\n" +
        "  • Если тариф понижен после создания endpoint'а — webhook автоматически деактивируется."
      );
    case 404:
      return (
        "Не найдено (404). " +
        (apiError ?? "Ресурс не существует.") +
        "\n  • Для pause-target: target_id (tgt_…) не принадлежит ни одному проекту этого webhook'а.\n" +
        "  • Если меняли структуру в UI — вызовите crosslybot_discover чтобы обновить кеш."
      );
    case 413:
      return "Payload слишком большой (413). Лимит body — 5 MB. Уменьшите размер.";
    case 422:
      if (errorCode === "invalid_targets") {
        return (
          "Невалидные targets (422). " +
          (apiError ?? "") +
          "\n  • Ни один из переданных tgt_… не совпал с активными целями проекта.\n" +
          "  • Цели проекта могли быть отключены/удалены — вызовите crosslybot_discover для актуального списка."
        );
      }
      return (
        "Невалидный payload (422). " +
        (apiError ?? "Проверьте поля запроса.") +
        "\n  • Проверьте обязательные поля: для публикации нужен text ИЛИ media.\n" +
        "  • Лимиты: text ≤15895 символов, media ≤10 файлов, paused_minutes 1..1440."
      );
    case 429: {
      const hint = retryAfter ? ` Повторите через ${retryAfter} сек.` : "";
      return (
        `Превышен rate-limit (429).${hint}\n` +
        "  • Webhook IN POST: до 100/1000/3000 запросов в час (Pro/Maxi/Business).\n" +
        "  • Discovery GET /info: до 60 в минуту.\n" +
        "  • Если кажется что лимит не должен был сработать — проверьте `min_interval_seconds` в карточке webhook IN."
      );
    }
    case 503:
      return (
        "Endpoint временно недоступен (503). " +
        (apiError ?? "") +
        "\n  • Endpoint выключен (`is_active=false`) — включите в UI Crosslybot.\n" +
        "  • Endpoint на паузе (`paused_until`) — дождитесь конца паузы или используйте crosslybot_resume_pause.\n" +
        "  • Soft-block после превышения rate-limit (12 часов) — проверьте раздел Безопасность в карточке."
      );
    default:
      if (err.status >= 500) {
        return (
          `Внутренняя ошибка сервера Crosslybot (${err.status}). ` +
          (apiError ?? "Попробуйте позже.") +
          "\n  • Если повторяется — напишите в поддержку support@crosslybot.ru."
        );
      }
      return `Ошибка Crosslybot API (${err.status}): ${apiError ?? JSON.stringify(body)}`;
  }
}

export class CrosslybotClient {
  private readonly baseUrl: string;
  private readonly slug: string;
  private readonly token: string;
  private readonly hmacSecret?: string;

  constructor(opts: { slug: string; token: string; baseUrl?: string; hmacSecret?: string }) {
    this.slug = opts.slug;
    this.token = opts.token;
    this.hmacSecret = opts.hmacSecret;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * GET /v1/webhooks/{slug}/info — discovery endpoint.
   * Если HMAC secret сконфигурирован — подписываем canonical method+path+timestamp.
   */
  async getInfo(): Promise<WebhookInfoResponse> {
    const path = `/v1/webhooks/${this.slug}/info`;
    const headers = this.buildHeaders({ method: "GET", path });
    const res = await fetch(`${this.baseUrl}${path}`, { method: "GET", headers });
    const body = await this.parseBody(res);
    if (!res.ok) {
      throw new CrosslybotApiError(
        `GET /info failed: HTTP ${res.status}`,
        res.status,
        body,
      );
    }
    return body as WebhookInfoResponse;
  }

  /**
   * POST /v1/webhooks/{slug} — публикация поста.
   * Если HMAC secret сконфигурирован — подписываем raw body.
   */
  async publish(
    payload: PublishPayload,
    opts: { idempotencyKey?: string } = {},
  ): Promise<PublishResponse> {
    const path = `/v1/webhooks/${this.slug}`;
    const body = JSON.stringify(payload);
    const headers = this.buildHeaders({ method: "POST", path, body });
    headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers, body });
    const responseBody = await this.parseBody(res);
    if (!res.ok) {
      throw new CrosslybotApiError(
        `POST publish failed: HTTP ${res.status}`,
        res.status,
        responseBody,
      );
    }
    return responseBody as PublishResponse;
  }

  /**
   * Собрать заголовки запроса с auth + timestamp + опциональной HMAC подписью.
   *
   * Timestamp шлём ВСЕГДА (даже без HMAC) — стоит ничего, но решает edge case
   * когда у webhook'а включён только `require_timestamp` без `require_signature`.
   * Если backend не требует timestamp — он проигнорирует header, не сломается.
   *
   * HMAC подпись — только если secret задан:
   * - GET: canonical "GET\n{path}\n{timestamp}".
   * - POST: raw body bytes.
   */
  private buildHeaders(opts: {
    method: "GET" | "POST";
    path: string;
    body?: string;
  }): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    const timestamp = Math.floor(Date.now() / 1000).toString();
    headers["X-Crosslybot-Timestamp"] = timestamp;

    if (!this.hmacSecret) {
      return headers;
    }
    let payload: string | Buffer;
    if (opts.method === "GET") {
      payload = `GET\n${opts.path}\n${timestamp}`;
    } else {
      payload = opts.body ?? "";
    }
    const sig = createHmac("sha256", this.hmacSecret).update(payload).digest("hex");
    headers["X-Crosslybot-Client-Signature"] = `sha256=${sig}`;
    return headers;
  }

  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
