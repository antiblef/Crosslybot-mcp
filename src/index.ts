#!/usr/bin/env node
/**
 * MCP-сервер для Crosslybot.
 *
 * Транспорт: SSE (Server-Sent Events) — клиент (Claude Desktop, Cursor, Cline)
 * подключается по URL `https://mcp.crosslybot.ru/sse/{slug}` с
 * `Authorization: Bearer crossly_live_...`. Сервер stateless, конфигурация
 * (slug + token) хранится у клиента в `claude_desktop_config.json` и т.п.
 *
 * Архитектура:
 *  - GET /sse/{slug}   — SSE handshake, slug+token извлекаются и связываются с sessionId.
 *  - POST /messages    — client→server JSON-RPC (внутри SDK).
 *  - /health           — health-check для Dokploy.
 *
 * Per-session state (in-memory): slug + token + CrosslybotClient + кеш /info (5 мин).
 * При перезапуске сервиса все sessions переподключатся.
 */

import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CrosslybotClient, CrosslybotApiError, formatApiError } from "./crosslybot-client.js";
import { InfoCache } from "./info-cache.js";
import {
  DISCOVER_TOOL_DEFINITION,
  DiscoverArgsSchema,
  executeDiscover,
} from "./tools/discover.js";
import {
  PUBLISH_TOOL_DEFINITION,
  PublishArgsSchema,
  executePublish,
} from "./tools/publish.js";

const PORT = parseInt(process.env.MCP_PORT ?? "8080", 10);
const BASE_URL = process.env.CROSSLYBOT_BASE_URL ?? "https://wh.crosslybot.ru";
const SERVER_VERSION = "0.1.0";

// Per-session state — sessionId выдаётся SDK при handshake.
interface SessionState {
  slug: string;
  client: CrosslybotClient;
  transport: SSEServerTransport;
}

const sessions = new Map<string, SessionState>();
const cache = new InfoCache();

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1].trim() : null;
}

function extractHmacSecret(req: Request): string | undefined {
  // Header может быть строкой или массивом — берём первое значение.
  const raw = req.headers["x-crosslybot-hmac-secret"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function setCorsHeaders(res: Response): void {
  // MCP-клиенты обычно гоняют через локальные процессы и Origin не отправляют,
  // но для будущих веб-клиентов оставим открытый CORS на этом сервисе.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function createMcpServer(client: CrosslybotClient, sessionIdGetter: () => string): Server {
  const server = new Server(
    { name: "crosslybot", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [DISCOVER_TOOL_DEFINITION, PUBLISH_TOOL_DEFINITION],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const sessionId = sessionIdGetter();
    try {
      switch (req.params.name) {
        case "crosslybot_discover": {
          DiscoverArgsSchema.parse(req.params.arguments ?? {});
          return await executeDiscover(client, sessionId, cache);
        }
        case "crosslybot_publish": {
          const args = PublishArgsSchema.parse(req.params.arguments ?? {});
          return await executePublish(args, client, sessionId, cache);
        }
        default:
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Unknown tool: ${req.params.name}`,
              },
            ],
          };
      }
    } catch (err) {
      if (err instanceof CrosslybotApiError) {
        // 401/403 — возможно токен ротировали, инвалидируем кеш чтобы при
        // следующем discover пошли заново на backend.
        if (err.status === 401 || err.status === 403) {
          cache.invalidate(sessionId);
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: formatApiError(err),
            },
          ],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Error: ${message}` },
        ],
      };
    }
  });

  return server;
}

const app = express();

// Health-check для Dokploy / load balancer.
app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "crosslybot-mcp",
    version: SERVER_VERSION,
    sessions: sessions.size,
  });
});

// CORS preflight.
app.options("/sse/:slug", (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});
app.options("/messages", (_req, res) => {
  setCorsHeaders(res);
  res.status(204).end();
});

// SSE handshake — клиент подключается сюда. URL: /sse/{slug}.
app.get("/sse/:slug", async (req, res) => {
  setCorsHeaders(res);

  const slug = req.params.slug;
  const token = extractToken(req);
  if (!slug || !token) {
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  // Pre-flight check: убеждаемся что slug + token (+ HMAC если включён) валидны.
  // Это не обязательно (MCP всё равно проверит при первом tool call), но улучшает
  // UX — при невалидных данных клиент сразу видит ошибку, а не «успех handshake → ошибка tool».
  const hmacSecret = extractHmacSecret(req);
  const client = new CrosslybotClient({ slug, token, hmacSecret, baseUrl: BASE_URL });
  try {
    await client.getInfo();
  } catch (err) {
    if (err instanceof CrosslybotApiError && (err.status === 401 || err.status === 403)) {
      res.status(401).json({ error: "Authorization required" });
      return;
    }
    // Прочие ошибки backend — 502.
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Crosslybot backend unavailable", details: message });
    return;
  }

  // SDK создаёт transport — его sessionId будет ключом в map.
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  let currentSessionId = sessionId;

  sessions.set(sessionId, { slug, client, transport });

  const mcpServer = createMcpServer(client, () => currentSessionId);

  // SDK закрывает transport при разрыве соединения — чистим session + кеш.
  transport.onclose = () => {
    sessions.delete(currentSessionId);
    cache.drop(currentSessionId);
  };

  try {
    await mcpServer.connect(transport);
  } catch (err) {
    sessions.delete(currentSessionId);
    cache.drop(currentSessionId);
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP handshake failed", details: message });
    }
  }
});

// Client → server JSON-RPC messages.
// Используем express.json() — SDK `handlePostMessage` ожидает уже распарсенный
// объект в third arg. Тип "*/*" чтобы принимать без Content-Type header (некоторые
// SDK-клиенты могут не выставлять его в SSE-mode).
app.post("/messages", express.json({ type: "*/*", limit: "10mb" }), async (req, res) => {
  setCorsHeaders(res);

  const sessionId = (req.query.sessionId as string) || "";
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP message handling failed", details: message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`[crosslybot-mcp] listening on :${PORT}, backend=${BASE_URL}`);
});

// Graceful shutdown — закрываем все sessions при SIGTERM (Dokploy redeploy).
function shutdown(signal: string): void {
  console.log(`[crosslybot-mcp] received ${signal}, closing ${sessions.size} sessions`);
  for (const [sessionId, session] of sessions) {
    try {
      session.transport.close();
    } catch {
      /* swallow */
    }
    cache.drop(sessionId);
  }
  sessions.clear();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
