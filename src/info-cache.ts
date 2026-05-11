/**
 * In-memory cache `/info` per session. TTL 5 минут.
 *
 * Уменьшает backend-нагрузку: при typical use (10 conversations подряд
 * за 5 мин) — 1 backend call вместо 10. Не persistent — при перезапуске
 * сервиса все sessions переподключатся и кеш заполнится заново.
 */

import type { CrosslybotClient, WebhookInfoResponse } from "./crosslybot-client.js";

const TTL_MS = 5 * 60 * 1000; // 5 минут

interface CacheEntry {
  info: WebhookInfoResponse;
  expiresAt: number;
}

export class InfoCache {
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Получить /info для session — из кеша или backend.
   * Cache key = sessionId (unique per SSE connection).
   */
  async get(sessionId: string, client: CrosslybotClient): Promise<WebhookInfoResponse> {
    const cached = this.cache.get(sessionId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.info;
    }
    const info = await client.getInfo();
    this.cache.set(sessionId, { info, expiresAt: now + TTL_MS });
    return info;
  }

  /**
   * Инвалидировать запись для session (например после ошибки 401/403 —
   * структура могла измениться, имеет смысл рефетчить).
   */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * Очистить запись session при закрытии SSE-соединения.
   */
  drop(sessionId: string): void {
    this.cache.delete(sessionId);
  }
}

/**
 * Fuzzy match цели по имени, public_id или платформе.
 *
 * Алгоритм:
 *  1. Если query похож на `tgt_...` — возвращаем как public_id без поиска.
 *  2. Substring case-insensitive поиск по target.name (если verbose=true).
 *  3. Если name=null (обезличенный режим) — fallback на platform.
 *
 * Возвращает первый match или null.
 */
export function resolveTarget(
  info: WebhookInfoResponse,
  query: string,
): { id: string; platform: string; name: string | null } | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // Прямой public_id — пропускаем поиск.
  if (/^tgt_[A-Za-z0-9_-]+$/.test(trimmed)) {
    for (const project of info.projects) {
      for (const target of project.targets) {
        if (target.id === trimmed) return target;
      }
    }
    return null;
  }

  const queryLower = trimmed.toLowerCase();

  // 1. Точное совпадение по name (case-insensitive).
  for (const project of info.projects) {
    for (const target of project.targets) {
      if (target.name && target.name.toLowerCase() === queryLower) {
        return target;
      }
    }
  }

  // 2. Substring match по name.
  for (const project of info.projects) {
    for (const target of project.targets) {
      if (target.name && target.name.toLowerCase().includes(queryLower)) {
        return target;
      }
    }
  }

  // 3. Fallback — match по platform (когда verbose=false).
  for (const project of info.projects) {
    for (const target of project.targets) {
      if (target.platform.toLowerCase() === queryLower) {
        return target;
      }
    }
  }

  return null;
}
