/**
 * Tools: crosslybot_pause / crosslybot_resume
 *
 * Phase 4.1.10: программная отложенная пауза БЕЗ публикации поста.
 *
 * crosslybot_pause:
 *  - project_minutes — пауза всего проекта (всех проектов webhook IN endpoint'а)
 *  - target_minutes  — глобальная пауза ресурсов целей. targets[] — public_id
 *    или имена (fuzzy match). Пусто = все цели.
 *  - минимум одно из (project_minutes, target_minutes) > 0.
 *
 * crosslybot_resume:
 *  - scope: project | targets | all (default all)
 *  - targets[] — какие цели снять (если scope=targets); пусто = все.
 *
 * Отличие от ad_pause_minutes в crosslybot_publish: здесь пауза ставится
 * отдельно, не требует публикации поста. Use-case: «забронировать тишину»
 * наперёд или снять её досрочно.
 */

import { z } from "zod";
import type { CrosslybotClient, TempPausePayload, TempResumePayload } from "../crosslybot-client.js";
import { InfoCache, resolveTarget } from "../info-cache.js";

// ---------- crosslybot_pause ----------

export const PauseArgsSchema = z
  .object({
    project_minutes: z.number().int().min(0).max(1440).optional()
      .describe("Пауза всего проекта в минутах (0..1440). 0 или не указано = не паузить проект."),
    target_minutes: z.number().int().min(0).max(1440).optional()
      .describe("Глобальная пауза ресурсов целей в минутах (0..1440). Действует во всех проектах владельца."),
    targets: z.array(z.string().min(1)).optional()
      .describe(
        "Список целей для target_minutes — public_id (tgt_…) или имя (fuzzy match по /info). " +
          "Пусто = все цели проекта.",
      ),
  })
  .strict()
  .refine(
    (d) => (d.project_minutes ?? 0) > 0 || (d.target_minutes ?? 0) > 0,
    { message: "Укажите project_minutes и/или target_minutes больше 0." },
  );

export const PAUSE_TOOL_DEFINITION = {
  name: "crosslybot_pause",
  description:
    "Поставить отложенную паузу БЕЗ публикации поста.\n\n" +
    "  • project_minutes — пауза всего проекта на N минут (все цели стоят).\n" +
    "  • target_minutes — глобальная пауза ресурсов целей на N минут. " +
    "Действует во ВСЕХ проектах владельца где используется этот канал.\n" +
    "  • targets — какие цели паузить (public_id tgt_… или имя для fuzzy match). " +
    "Пусто = все цели проекта.\n\n" +
    "Минимум одно из project_minutes / target_minutes должно быть > 0.\n" +
    "Чтобы поставить паузу ВМЕСТЕ с публикацией — используйте crosslybot_publish " +
    "с ad_pause_minutes / ad_target_pause_minutes.\n\n" +
    "Идемпотентно: не сокращает уже активную более длинную паузу.",
  inputSchema: {
    type: "object",
    properties: {
      project_minutes: { type: "integer", minimum: 0, maximum: 1440 },
      target_minutes: { type: "integer", minimum: 0, maximum: 1440 },
      targets: {
        type: "array",
        items: { type: "string" },
        description: "Список целей для target_minutes — public_id (tgt_…) или имя для fuzzy match.",
      },
    },
  },
} as const;

export async function executePause(
  args: z.infer<typeof PauseArgsSchema>,
  client: CrosslybotClient,
  sessionId: string,
  cache: InfoCache,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  // Резолвим targets по именам (если переданы) через /info cache.
  let resolvedTargets: string[] | undefined;
  if (args.targets && args.targets.length > 0) {
    const info = await cache.get(sessionId, client);
    resolvedTargets = [];
    const unresolved: string[] = [];
    for (const raw of args.targets) {
      const target = resolveTarget(info, raw);
      if (target) {
        resolvedTargets.push(target.id);
      } else {
        unresolved.push(raw);
      }
    }
    if (unresolved.length > 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Не удалось разрешить цели: ${unresolved.join(", ")}. ` +
              `Вызовите crosslybot_discover чтобы увидеть доступные цели.`,
          },
        ],
      };
    }
  }

  const payload: TempPausePayload = {};
  if (args.project_minutes !== undefined) payload.project_minutes = args.project_minutes;
  if (args.target_minutes !== undefined) payload.target_minutes = args.target_minutes;
  if (resolvedTargets) payload.targets = resolvedTargets;

  const result = await client.tempPause(payload);

  const parts: string[] = ["Отложенная пауза установлена."];
  if (result.projects_affected > 0) {
    parts.push(`Проектов на паузе: ${result.projects_affected}.`);
  }
  if (result.resources_affected > 0) {
    parts.push(`Ресурсов (целей) на паузе: ${result.resources_affected}.`);
  }
  if (result.rescheduled_post_targets > 0) {
    parts.push(`Накопленных постов перенесено: ${result.rescheduled_post_targets}.`);
  }
  parts.push(`request_id=${result.request_id}.`);

  return { content: [{ type: "text" as const, text: parts.join(" ") }] };
}

// ---------- crosslybot_resume ----------

export const ResumeArgsSchema = z
  .object({
    scope: z.enum(["project", "targets", "all"]).optional()
      .describe("Что снять: project (паузы проектов), targets (паузы ресурсов целей), all (всё). Default: all."),
    targets: z.array(z.string().min(1)).optional()
      .describe("Какие цели снять (если scope=targets) — public_id или имя. Пусто = все цели."),
  })
  .strict();

export const RESUME_TOOL_DEFINITION = {
  name: "crosslybot_resume",
  description:
    "Досрочно снять отложенную паузу (поставленную через crosslybot_pause или crosslybot_publish).\n\n" +
    "  • scope=project — снять паузы всех проектов endpoint'а.\n" +
    "  • scope=targets — снять глобальные паузы ресурсов целей (targets[] = какие, пусто = все).\n" +
    "  • scope=all (по умолчанию) — снять и проектные, и ресурсные паузы.\n\n" +
    "Накопленные за время паузы посты публикуются с интервалом 1 мин после снятия.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["project", "targets", "all"] },
      targets: {
        type: "array",
        items: { type: "string" },
        description: "Список целей (если scope=targets) — public_id или имя для fuzzy match.",
      },
    },
  },
} as const;

export async function executeResume(
  args: z.infer<typeof ResumeArgsSchema>,
  client: CrosslybotClient,
  sessionId: string,
  cache: InfoCache,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  let resolvedTargets: string[] | undefined;
  if (args.targets && args.targets.length > 0) {
    const info = await cache.get(sessionId, client);
    resolvedTargets = [];
    const unresolved: string[] = [];
    for (const raw of args.targets) {
      const target = resolveTarget(info, raw);
      if (target) {
        resolvedTargets.push(target.id);
      } else {
        unresolved.push(raw);
      }
    }
    if (unresolved.length > 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Не удалось разрешить цели: ${unresolved.join(", ")}. ` +
              `Вызовите crosslybot_discover чтобы увидеть доступные цели.`,
          },
        ],
      };
    }
  }

  const payload: TempResumePayload = {};
  if (args.scope) payload.scope = args.scope;
  if (resolvedTargets) payload.targets = resolvedTargets;

  const result = await client.tempResume(payload);

  const parts: string[] = ["Отложенная пауза снята."];
  if (result.projects_affected > 0) {
    parts.push(`Проектов возобновлено: ${result.projects_affected}.`);
  }
  if (result.resources_affected > 0) {
    parts.push(`Ресурсов (целей) возобновлено: ${result.resources_affected}.`);
  }
  if (result.rescheduled_post_targets > 0) {
    parts.push(`Накопленных постов к публикации: ${result.rescheduled_post_targets}.`);
  }
  if (result.projects_affected === 0 && result.resources_affected === 0) {
    parts.push("Активных пауз не было.");
  }
  parts.push(`request_id=${result.request_id}.`);

  return { content: [{ type: "text" as const, text: parts.join(" ") }] };
}
