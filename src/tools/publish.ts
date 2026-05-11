/**
 * Tool: crosslybot_publish
 *
 * Публикует пост в Crosslybot через webhook IN. Поддерживает:
 *  - text (markdown via TG-style entities неподдержан в MVP — только plain).
 *  - media: до 10 photo/video/audio (только URL, не base64).
 *  - targets: список celей. Принимает public_id (tgt_…) или человеко-читаемое имя
 *    (fuzzy match по name из /info). Если пустой — публикация во все активные цели.
 *  - is_advertisement + ad_pause_minutes / ad_target_pause_minutes — автопауза.
 *  - idempotency_key — для безопасных повторов.
 */

import { z } from "zod";
import type { CrosslybotClient, MediaItem, PublishPayload } from "../crosslybot-client.js";
import { InfoCache, resolveTarget } from "../info-cache.js";

export const PublishArgsSchema = z
  .object({
    text: z.string().min(1).optional(),
    media: z
      .array(
        z.object({
          type: z.enum(["photo", "video", "audio"]),
          url: z.string().url(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          duration: z.number().int().nonnegative().optional(),
        }),
      )
      .max(10)
      .optional(),
    targets: z.array(z.string().min(1)).optional()
      .describe(
        "Список целей. Каждый элемент — public_id (tgt_…) ИЛИ имя цели (fuzzy match по name из /info). " +
          "Пусто = публикация во все активные цели проекта.",
      ),
    is_advertisement: z.boolean().optional(),
    ad_pause_minutes: z.number().int().min(0).max(1440).optional()
      .describe("Пауза проекта в минутах после публикации (0..1440). Применяется один раз."),
    ad_target_pause_minutes: z.number().int().min(0).max(1440).optional()
      .describe("Пауза каждой опубликованной цели индивидуально (0..1440)."),
    idempotency_key: z.string().max(128).optional(),
  })
  .strict()
  .refine(
    (data) => data.text || (data.media && data.media.length > 0),
    { message: "Нужен хотя бы text или media — пост не может быть пустым." },
  );

export const PUBLISH_TOOL_DEFINITION = {
  name: "crosslybot_publish",
  description:
    "Опубликовать пост в Crosslybot и (опционально) поставить проект/цели на отложенную паузу.\n\n" +
    "Минимум: text ИЛИ media.\n\n" +
    "targets: список целей — каждая может быть public_id (tgt_…) или фрагментом имени " +
    "(например 'маркетинг' — найдёт целевой канал с name содержащим эту подстроку). " +
    "Пустой targets = публикация во все активные цели проекта.\n\n" +
    "Отложенные паузы после публикации (включаются вместе с публикацией поста):\n" +
    "  • ad_pause_minutes — пауза всего ПРОЕКТА на N минут после первой успешной публикации " +
    "(применяется один раз).\n" +
    "  • ad_target_pause_minutes — пауза каждой ОПУБЛИКОВАННОЙ цели на N минут (per-target). " +
    "Можно использовать вместе с ad_pause_minutes.\n" +
    "  • Если нужна 'тишина без поста' — отправьте минимальный пост (например 'ok') с нужной паузой.\n\n" +
    "Возвращает post_ids и delivery_id для трассировки.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Текст поста (plain). Лимит 15895 символов." },
      media: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["photo", "video", "audio"] },
            url: { type: "string", format: "uri" },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
            duration: { type: "integer", minimum: 0 },
          },
          required: ["type", "url"],
        },
      },
      targets: {
        type: "array",
        items: { type: "string" },
        description: "Список целей. Каждая — public_id (tgt_…) или имя для fuzzy match.",
      },
      is_advertisement: { type: "boolean" },
      ad_pause_minutes: { type: "integer", minimum: 0, maximum: 1440 },
      ad_target_pause_minutes: { type: "integer", minimum: 0, maximum: 1440 },
      idempotency_key: { type: "string", maxLength: 128 },
    },
  },
} as const;

export async function executePublish(
  args: z.infer<typeof PublishArgsSchema>,
  client: CrosslybotClient,
  sessionId: string,
  cache: InfoCache,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  // Резолвим targets — если переданы имена, найти public_id через /info cache.
  let resolvedTargets: { id: string }[] | undefined;
  const unresolved: string[] = [];

  if (args.targets && args.targets.length > 0) {
    const info = await cache.get(sessionId, client);
    resolvedTargets = [];
    for (const raw of args.targets) {
      const target = resolveTarget(info, raw);
      if (target) {
        resolvedTargets.push({ id: target.id });
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

  const payload: PublishPayload = {};
  if (args.text) payload.text = args.text;
  if (args.media) payload.media = args.media as MediaItem[];
  if (resolvedTargets) payload.targets = resolvedTargets;
  if (args.is_advertisement !== undefined) payload.is_advertisement = args.is_advertisement;
  if (args.ad_pause_minutes !== undefined) payload.ad_pause_minutes = args.ad_pause_minutes;
  if (args.ad_target_pause_minutes !== undefined) {
    payload.ad_target_pause_minutes = args.ad_target_pause_minutes;
  }

  const result = await client.publish(payload, {
    idempotencyKey: args.idempotency_key,
  });

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Пост опубликован. post_ids=${JSON.stringify(result.post_ids)}, ` +
          `delivery_id=${result.delivery_id}, request_id=${result.request_id}.`,
      },
    ],
  };
}
