# Crosslybot MCP Server

MCP-сервер для Crosslybot — позволяет AI-агентам (Claude Desktop, Cursor, Cline, Continue и другим MCP-клиентам) **публиковать посты** в ваши каналы Telegram / VK / Max и **управлять отложенными паузами** через простые команды.

**Hosted-вариант** (рекомендуется): подключайтесь по URL `https://mcp.crosslybot.ru/sse/{slug}` или `https://mcp.crosslybot.com/sse/{slug}` — ничего не устанавливать локально. Оба домена ведут на тот же сервис, выбирайте любой.

**Self-hosted** (опционально): запускайте этот образ у себя через Docker / npm.

---

## Что умеет MCP

После подключения у AI-агента появляются два tools:

### `crosslybot_discover`

Возвращает список **проектов** и **целей публикации** (Telegram-каналы, VK-группы, Max-каналы), привязанных к вашему webhook. Используется AI в начале разговора чтобы понять «куда можно публиковать». Также показывает лимиты payload'а и поведенческие состояния (paused_until, если канал на паузе).

### `crosslybot_publish`

Опубликовать пост с (опционально):
- **Текстом и медиа**: до 10 фото/видео/аудио (только URL, не локальные файлы).
- **Адресной публикацией**: `targets` — список public_id (`tgt_…`) или **фрагментов имени** ("маркетинг" → найдёт целевой канал с name содержащим эту подстроку).
- **Отложенной паузой** после публикации:
  - `ad_pause_minutes` — пауза всего проекта на N минут.
  - `ad_target_pause_minutes` — пауза каждой опубликованной цели на N минут.
- **Idempotency-key** — для безопасных повторов запросов.

---

## Быстрый старт (Hosted)

### 1. Получите URL и токен

В Crosslybot Web/Mini App создайте **webhook IN** endpoint (Pro+ тариф):
- Скопируйте `Incoming URL` — получите slug в виде `KfuRo4n7yDhk_QXgV3LrvA`.
- Скопируйте `Bearer token` (`crossly_live_…`) — показывается **один раз** при создании.

### 2. Включите `expose_names_in_info` (рекомендуется)

В карточке webhook IN → раздел «Безопасность» → toggle **«Раскрывать имена в discovery (/info)»**. Иначе MCP не сможет находить цели по именам ("маркетинг" → tgt_…), только по public_id.

### 3. Настройте MCP-клиент

#### Claude Desktop

`~/.config/Claude/claude_desktop_config.json` (или **`%APPDATA%\Claude\claude_desktop_config.json`** на Windows):

```json
{
  "mcpServers": {
    "crosslybot": {
      "url": "https://mcp.crosslybot.ru/sse/KfuRo4n7yDhk_QXgV3LrvA",
      "headers": {
        "Authorization": "Bearer crossly_live_..."
      }
    }
  }
}
```

Перезапустите Claude Desktop.

#### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "crosslybot": {
      "url": "https://mcp.crosslybot.ru/sse/KfuRo4n7yDhk_QXgV3LrvA",
      "headers": {
        "Authorization": "Bearer crossly_live_..."
      }
    }
  }
}
```

#### Cline (VS Code)

В настройках Cline → MCP servers → Edit raw JSON. То же содержимое.

### 4. Готово

Откройте чат и попросите AI опубликовать пост:

> Опубликуй в маркетинг-канал: «Релиз v2.0 завтра!»

AI вызовет `crosslybot_discover` (узнает что у вас за каналы), потом `crosslybot_publish` с найденным `tgt_…`.

---

## С HMAC-защитой (включена в UI webhook'а)

Если у webhook'а включён toggle **«Требовать HMAC-подпись от отправителя»** в разделе «Безопасность» — добавьте `X-Crosslybot-Hmac-Secret` header:

```json
{
  "mcpServers": {
    "crosslybot": {
      "url": "https://mcp.crosslybot.ru/sse/{slug}",
      "headers": {
        "Authorization": "Bearer crossly_live_...",
        "X-Crosslybot-Hmac-Secret": "p8jtNzwgvMqR7gcWJNLNcKf8g-47h0AdVjfdsk54b6Y"
      }
    }
  }
}
```

MCP-сервер сам подписывает каждый запрос к backend HMAC-SHA256:
- POST `/v1/webhooks/{slug}` — подпись от raw body.
- GET `/v1/webhooks/{slug}/info` — подпись от canonical `GET\n{path}\n{timestamp}`.

Timestamp (`X-Crosslybot-Timestamp`) клиент шлёт **всегда** — даже без HMAC. Это покрывает случай когда у вас включён только `require_timestamp` без HMAC.

---

## IP allowlist

Если в карточке webhook'а указан **IP allowlist**, нужно добавить **IP hosted MCP-сервера** в whitelist:

```
89.223.125.61
```

Иначе все запросы от MCP к backend будут отклоняться с 401.

При **self-hosted** MCP — добавьте IP вашего сервера.

---

## Self-hosted

Когда стоит выбрать self-hosted:
- **Privacy / комплаенс** — slug, token и payload'ы не покидают вашу инфраструктуру (между MCP-сервером и backend Crosslybot всё равно идёт HTTPS, но сам MCP под вашим контролем).
- **IP allowlist** — в карточке webhook'а указать **IP вашего self-hosted сервера** вместо `89.223.125.61` (hosted MCP).
- **Кастомный backend** — если вы поднимаете полный self-hosted Crosslybot, указать через `CROSSLYBOT_BASE_URL`.

### Способ 1 — Docker (одной командой)

```bash
docker run -d --name crosslybot-mcp -p 8080:8080 \
  -e CROSSLYBOT_BASE_URL=https://wh.crosslybot.ru \
  ghcr.io/antiblef/crosslybot-mcp:latest
```

Затем в `claude_desktop_config.json` — `"url": "http://localhost:8080/sse/{slug}"`.

Если ставите на удалённый VPS — поднимите перед ним reverse-proxy с HTTPS (Caddy/Traefik/nginx) и используйте `https://<домен>/sse/{slug}`.

### Способ 2 — docker compose

```bash
git clone https://github.com/antiblef/crosslybot-mcp.git
cd crosslybot-mcp
docker compose up -d
```

Готовый `docker-compose.yml` лежит в репозитории — отредактируйте `CROSSLYBOT_BASE_URL` если нужен другой backend.

### Способ 3 — собрать из исходников

```bash
git clone https://github.com/antiblef/crosslybot-mcp.git
cd crosslybot-mcp
npm install
npm run build
npm start
```

Слушает `0.0.0.0:8080` (или `$MCP_PORT`).

### ENV переменные

| Переменная | Default | Описание |
|---|---|---|
| `MCP_PORT` | `8080` | Порт HTTP-сервера. |
| `CROSSLYBOT_BASE_URL` | `https://wh.crosslybot.ru` | Backend Crosslybot. Есть зеркало `https://wh.crosslybot.com` (тот же сервис), либо ваш self-hosted backend. |

### Проверка работоспособности

```bash
curl -f http://localhost:8080/health
# → {"ok":true,"service":"crosslybot-mcp","version":"0.1.0","sessions":0}
```

### Образ для разных архитектур

GHCR-образ публикуется для `linux/amd64` и `linux/arm64` (включая Apple Silicon в Docker Desktop) — Docker автоматически подбирает нужный вариант при `docker pull`.

---

## Архитектура

```
Claude Desktop / Cursor / Cline
        │
        │ SSE (Server-Sent Events) + JSON-RPC
        │ Authorization: Bearer crossly_live_...
        │ (X-Crosslybot-Hmac-Secret: ...)
        ▼
https://mcp.crosslybot.ru/sse/{slug}    ← MCP-сервер (этот репозиторий)
        │
        │ HTTPS
        │ Authorization: Bearer (forwarded)
        │ X-Crosslybot-Timestamp + X-Crosslybot-Client-Signature (если HMAC)
        ▼
https://wh.crosslybot.ru/v1/webhooks/{slug}/...    ← Backend Crosslybot
        │
        ▼
[Telegram / VK / Max] — реальные платформы
```

### Безопасность

- **MCP-сервер stateless**: in-memory map sessions, при перезапуске чистится.
- **Никакой БД** на стороне MCP — конфигурация (slug + token) хранится у клиента в `claude_desktop_config.json`.
- **Кеш `/info`**: TTL 5 минут per session — снижает backend-нагрузку, актуально для multi-conversation сценариев.

### Tools — детальная документация

#### `crosslybot_discover`

**Параметры**: нет.

**Возвращает**: текстовый список проектов и целей. Пример:

```
Crosslybot webhook: Маркетинговый
Verbose режим: да (имена видны)

Проектов: 1

Project 1: Маркетинг отдела
  Цели:
    • id=tgt_aBc..., platform=telegram, name="Анонсы"
    • id=tgt_xYz..., platform=max, name="Команда"

Capabilities:
  Max text length: 15895
  Max media items: 10
  Max pause minutes: 1440
  Media types: photo, video, audio
  Entity types: 18 (bold, italic, code, etc.)
```

#### `crosslybot_publish`

**Параметры**:

| Поле | Тип | Описание |
|---|---|---|
| `text` | string | Текст поста. Plain text. Лимит 15895 символов. |
| `media` | array | До 10 элементов: `{type, url, width?, height?, duration?}`. Type: `photo`, `video`, `audio`. URL HTTPS. |
| `targets` | string[] | Список целей. Каждая — `tgt_…` или fuzzy match по имени. Пусто = во все. |
| `is_advertisement` | bool | Маркер рекламного поста (для статистики). |
| `ad_pause_minutes` | int | 0..1440. Пауза **проекта** после публикации. |
| `ad_target_pause_minutes` | int | 0..1440. Пауза **каждой опубликованной цели**. |
| `idempotency_key` | string | До 128 символов. Для безопасных повторов. |

**Возвращает**: `post_ids`, `delivery_id`, `request_id`.

### Лимиты

- Webhook IN rate-limit: 100/300/1000 запросов в час (тарифы Pro/Maxi/Business).
- Discovery (`/info`) rate-limit: 60 запросов в минуту.
- Min-interval (по умолчанию): 10 секунд между запросами per slot. Настраивается в карточке webhook.

При превышении — backend возвращает 429, MCP пробрасывает в LLM с понятным объяснением.

---

## Развитие

Текущая версия `0.1.0` — MVP с двумя tools. План на будущее:

- **`crosslybot_pause_project` / `crosslybot_pause_target`** — отдельные tools для паузы без публикации (требует расширения backend).
- **OAuth flow** — «Connect Crosslybot» через web UI без копирования токена.
- **Поддержка локальных файлов** — через signed S3 upload (пока требуются HTTPS URL).
- **Resources & Prompts** — кроме tools.

---

## Лицензия

MIT.

## Поддержка

- Документация: <https://mcp.crosslybot.ru> (RU) или <https://mcp.crosslybot.com> (EN)
- Документация webhook API: <https://crosslybot.ru/webhooks> (RU) или <https://crosslybot.com/webhooks> (EN).
- Email: support@crosslybot.ru
