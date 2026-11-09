#!/usr/bin/env bash
# Сервер HTB LLM для e2e: чистый каталог данных + мок модели. Реальные задачи не трогает.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${E2E_DATA:-$PWD/tests/.data}"
APP_PORT="${E2E_APP_PORT:-17331}" MOCK_PORT="${E2E_MOCK_PORT:-18080}"
# прибрать контейнеры прошлого прогона (по метке каталога данных) и сам каталог (файлы root — чистим через docker)
ids=$(docker ps -aq --filter "label=whitehat.data=$DATA" || true)
[[ -n "$ids" ]] && docker rm -f $ids >/dev/null 2>&1 || true
if [[ -d "$DATA" ]]; then docker run --rm -v "$DATA:/d" "${WH_IMAGE:-htb-llm-kali:latest}" sh -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true; rm -rf "$DATA"; fi
mkdir -p "$DATA"
# мок-эмбеддинги — хэш слов, абсолютная близость у них бессмысленна: порог автоподклейки отключаем
export WH_RECALL_MIN_SIM=0
# построение базы знаний из веба в e2e — только свой гайд htb-00, без клонов внешних репозиториев
export WH_KNOWLEDGE_ARGS="--only htb-00-methodology"
# Механика сворачивания в e2e гоняется на компактном пороге 12K; продуктовый дефолт 32K проверяется
# отдельным тестом на своём сервере без WH_COMPACT_AT (25-context.spec.ts).
export WH_COMPACT_AT="${WH_COMPACT_AT:-12000}"
# управление настоящими моделями из веба в тестах выключено: «модель» здесь мок на том же localhost
export WH_SERVICES=off
# HTB API в тестах — стаб внутри mock-llm (токен test-htb-token-0123456789), не настоящий labs.hackthebox.com
export WH_HTB_API_URL="http://127.0.0.1:${MOCK_PORT}/api"
# Веб-поиск (SearXNG) в тестах — стаб внутри mock-llm; приватные адреса для web_fetch разрешены только здесь,
# чтобы тест мог читать стаб-страницу на localhost (в бою гард приватных адресов включён)
export WH_SEARXNG_URL="http://127.0.0.1:${MOCK_PORT}" WH_WEB_ALLOW_PRIVATE=1
# своя сборка интерфейса (E2E_WEB_DIST) — иначе web/dist
[[ -n "${E2E_WEB_DIST:-}" ]] && export WH_WEB_DIST="$E2E_WEB_DIST"
export WH_PORT=$APP_PORT WH_DATA="$DATA" WH_LLM_URL=http://127.0.0.1:$MOCK_PORT/v1 WH_EMBED_URL=http://127.0.0.1:$MOCK_PORT/v1 WH_LLM_MODEL=Qwen3.8-27B-Turbo
exec node --import tsx src/server/index.ts
