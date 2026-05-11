/**
 * Tool: crosslybot_discover
 *
 * Возвращает список проектов и целей webhook'а. Используется LLM в начале
 * conversation для понимания «куда можно публиковать».
 */

import { z } from "zod";
import type { CrosslybotClient } from "../crosslybot-client.js";
import { InfoCache } from "../info-cache.js";

export const DiscoverArgsSchema = z.object({}).strict();

export const DISCOVER_TOOL_DEFINITION = {
  name: "crosslybot_discover",
  description:
    "Получить список проектов и целей публикации Crosslybot. Возвращает массив проектов, " +
    "в каждом — массив целей с public_id (tgt_…), платформой (telegram/vk/max), именем " +
    "(если включён verbose режим), и paused_until (если цель/проект на отложенной паузе). " +
    "Используйте в начале разговора чтобы узнать какие цели доступны. Результат кешируется " +
    "5 минут — повторный вызов в той же сессии быстрый.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const;

export async function executeDiscover(
  client: CrosslybotClient,
  sessionId: string,
  cache: InfoCache,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const info = await cache.get(sessionId, client);

  // Форматируем человеко-читаемый ответ для LLM.
  const verbose = info.endpoint.verbose;
  const lines: string[] = [];
  lines.push(`Crosslybot webhook: ${info.endpoint.name ?? "(имя скрыто)"}`);
  lines.push(`Verbose режим: ${verbose ? "да (имена видны)" : "нет (только id+платформа)"}`);
  lines.push("");

  if (info.projects.length === 0) {
    lines.push("Проектов не привязано к webhook'у. Добавьте webhook как источник в проект через UI Crosslybot.");
  } else {
    lines.push(`Проектов: ${info.projects.length}`);
    for (const project of info.projects) {
      lines.push("");
      lines.push(`Project ${project.index}: ${project.name ?? "(имя скрыто)"}`);
      if (project.paused_until) {
        lines.push(`  На паузе до ${project.paused_until}`);
      }
      lines.push("  Цели:");
      for (const target of project.targets) {
        const parts = [
          `id=${target.id}`,
          `platform=${target.platform}`,
        ];
        if (target.name) parts.push(`name="${target.name}"`);
        if (target.paused_until) parts.push(`paused_until=${target.paused_until}`);
        lines.push(`    • ${parts.join(", ")}`);
      }
    }
  }

  lines.push("");
  lines.push("Capabilities:");
  lines.push(`  Max text length: ${info.capabilities.limits.max_text_length}`);
  lines.push(`  Max media items: ${info.capabilities.limits.max_media}`);
  lines.push(`  Max pause minutes: ${info.capabilities.limits.max_pause_minutes}`);
  lines.push(`  Media types: ${info.capabilities.media_types.join(", ")}`);
  lines.push(`  Entity types: ${info.capabilities.entity_types.length} (bold, italic, code, etc.)`);

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
