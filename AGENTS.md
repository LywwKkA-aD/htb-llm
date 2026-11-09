# AGENTS.md — HTB LLM (unofficial)

Инструкции для людей и кодинг-агентов, работающих с этим репозиторием. Пользовательская установка и обзор — в [README.md](README.md); здесь только то, что нужно не сломать при разработке.

## Что это за проект

HTB LLM — локальный веб-ассистент для HackTheBox и HTB Academy. Пользователь управляет решением, а LLM действует как инструмент: объясняет, выполняет ограниченные этапы в Kali-песочнице, ведёт план/профиль цели и предлагает память на подтверждение.

Проект неофициальный и не аффилирован с HackTheBox. Не используйте официальный логотип HTB и не представляйте продукт официальным. Видимый бренд — **HTB LLM (unofficial)** и собственный куб-логотип в `web/src/ui.tsx` / `web/public/favicon.svg`.

## Архитектура

- `src/server/` — Express + LangGraph сервер на TypeScript (tsx).
  - `graph.ts` — ход агента, guided-бюджет, компактинг, guardrails, вызовы инструментов.
  - `tools.ts` — схемы и исполнение инструментов модели.
  - `llm.ts` — OpenAI-compatible клиент, streaming, reasoning, эмбеддинги.
  - `settings.ts` — пресеты моделей/эмбеддингов, ключи, подагенты, management-ключ OpenRouter.
  - `openrouter.ts` — статистика OpenRouter и reasoning-метаданные моделей.
  - `sandbox.ts` — Docker/Kali на задачу, VPN, терминалы, jobs, SOCKS.
  - `library.ts`, `memory.ts`, `plan.ts`, `profile.ts` — RAG, память, план и профиль цели.
  - `spoilers.ts`, `injection.ts` — серверные политики безопасности. Не ослабляйте их ради удобства тестов.
- `web/src/` — React UI. Основные поверхности: `App.tsx` (shell), `components/Chat.tsx`, `Sidebar.tsx`, `Terminals.tsx`, `Settings.tsx`, `Panels.tsx`, `Files.tsx`, `Jobs.tsx`, `Plan.tsx`, `Profile.tsx`.
- `docker/kali/Dockerfile` — воспроизводимый Kali-образ песочниц. Изменения инструментов фиксируйте здесь, а не ручной установкой в живой контейнер.
- `Dockerfile`, `compose.yaml`, `docker/run.sh` — автономный Linux-запуск приложения, SearXNG и сборки Kali через host Docker socket.
- `knowledge/` — собственные методические карточки и `sources.lock.json`. Внешние корпуса скачиваются в игнорируемый `data/knowledge/` скриптом `scripts/knowledge.mts`.
- `tests/e2e/` — Playwright e2e на мок-LLM и настоящем Docker/Kali.

## Неприкосновенные инварианты

1. **Guided по умолчанию.** Модель — управляемый инструмент, а не автономный решатель. Не меняйте дефолтный режим и бюджеты без явного продуктового решения.
2. **Политика спойлеров серверная.** Готовые writeup/walkthrough по текущей машине нельзя искать или читать без явного разрешения пользователя на конкретный ход. Новые сетевые инструменты обязаны проходить ту же проверку.
3. **Одна задача — свой Kali и `/work`.** Не смешивайте файлы, VPN, jobs и терминалы разных задач.
4. **Legacy-идентификаторы совместимости не переименовывать без миграции:** переменные `WH_*`, префикс контейнеров `whitehat-`, сеть `whitehat-sbx`, БД `data/whitehat.db`, скрытая папка `.whitehat`, localStorage-ключи `wh.*` и симлинк `bin/whitehat`. Видимый бренд при этом — HTB LLM.
5. **Ключи не отдавать в браузер.** Публичный вид настроек содержит только `apiKeySet`. Не логируйте и не возвращайте API-ключи, HTB-токены и VPN-конфиги.
6. **Reasoning нельзя угадывать.** Для OpenRouter берите `supported_efforts/default_effort/mandatory` из метаданных конкретной модели. GLM 5.3 Flash принимает только `max/high/low` и не отключается.
7. **Эмбеддинг-модель определяет индекс.** Смена модели или размерности требует переиндексации; до неё поиск должен честно деградировать в полнотекстовый, а не молча сравнивать чужие векторные пространства.
8. **Docker socket = root-эквивалент.** Не публикуйте веб-порт наружу по умолчанию и не ослабляйте Host/Origin-guard ради Docker-порта: loopback с другим портом разрешён, чужие имена — нет.

## Команды

Хостовый режим:

```bash
corepack enable
corepack prepare pnpm@12.11.2 --activate
pnpm install --frozen-lockfile
pnpm build
docker build -t htb-llm-kali:latest docker/kali
bin/htb-llm start --web-only --no-open
curl http://127.0.0.1:7331/api/health
```

Docker (рекомендуемый пользовательский путь):

```bash
./docker/run.sh
./docker/run.sh status
./docker/run.sh knowledge
./docker/run.sh down
```

Тесты и проверки:

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p web/tsconfig.json
./node_modules/.bin/playwright test tests/e2e/<relevant>.spec.ts
pnpm test:e2e
```

E2E используют мок-модель из `tests/mock-llm.mjs` и изолированный `tests/.data`. Не запускайте настоящую локальную LLM ради обычных e2e. Живую модель проверяйте только если пользователь явно включил/разрешил её и в чатах нет активного хода.

## Данные, знания и публикация

- `data/` всегда локальная и gitignored: БД, настройки и ключи, VPN, задачи, загруженные документы, внешние источники знаний и векторный индекс. Никогда не добавляйте её в Git и не копируйте в публичные артефакты.
- Собственные знания коммитятся в `knowledge/*.md`. Внешние репозитории не вендорятся: `scripts/knowledge.mts` скачивает их из upstream по `knowledge/sources.lock.json`.
- InternalAllTheThings не имеет файла лицензии — только локальное использование. HackTricks — CC BY-NC, GTFOBins/LOLBAS — GPL-3.0. Не публикуйте скачанные корпуса или построенный из них индекс как часть этого репозитория.
- Обновление знаний: сначала `WH_KNOWLEDGE_LATEST=1 pnpm knowledge` или `./docker/run.sh knowledge` с соответствующим env, затем перенесите новые commit SHA из `data/knowledge/manifest.json` в `knowledge/sources.lock.json` и проверьте обычный locked-запуск.
- Перед публичной публикацией сканируйте tracked-файлы на секреты и персональные пути. Тестовые `sk-or-*` в спеках — фейковые значения мока, но настоящие ключи никогда не должны попадать даже в скриншоты.

## Docker-детали, которые легко сломать

- Приложение в Compose видит данные как `/data`, а Docker daemon создаёт Kali с bind-путём хоста. Для этого `WH_HOST_DATA` переводит пути через `hostPath()` в `src/server/config.ts`. Не возвращайте сырой `/data/...` в Docker `Binds`.
- `docker/run.sh` сам выставляет `HTB_UID`, `HTB_GID`, `DOCKER_GID` и `WH_HOST_DATA`. Прямой `docker compose up` без этих переменных намеренно падает на `WH_HOST_DATA`, чтобы не создать битые bind-пути.
- Одноразовый сервис `kali-image` в Compose нужен только для сборки образа и условия `service_completed_successfully`; рабочие Kali задач создаёт уже само приложение.
- В Docker локальные llama-процессы не управляются из UI (`WH_SERVICES=off`). Локальный пресет смотрит на `host.docker.internal`; OpenRouter работает без хостовых моделей.
- Рендер веб-страниц в Docker использует системный Chromium через `WH_BROWSER_PATH=/usr/bin/chromium`.

## Дизайн

Интерфейс следует визуальному языку HTB Labs, но не копирует официальный логотип или приватные ассеты:

- верхняя полоса 56px с брендом, поиском задач и статусом соединения;
- плоские тёмно-синие поверхности из токенов `web/src/styles.css`;
- лаймовый акцент `#9fef00`, Roboto/Roboto Mono;
- радиусы панелей и контролов не больше 4px, без «пузырей» и glow-теней;
- собственный `BrandMark` вместо официального знака HTB.

При намеренном изменении shell/геометрии обновляйте layout-спеки и визуальные эталоны только после просмотра фактических скриншотов. Нельзя ослаблять инварианты отсутствия перекрытий и обрезки контролов.

## Релизы

Локальная история проекта ведётся patch-тегами `0.1.x`: один завершённый пункт — коммит, синхронизированная версия в `package.json`, тег и проверка релевантных спеков. Публичный репозиторий может начинаться с чистой санитизированной истории; не пушьте локальные теги и `data/` автоматически.

