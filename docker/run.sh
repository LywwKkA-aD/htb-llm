#!/usr/bin/env bash
# HTB LLM (unofficial) — автономный Linux-запуск через Docker Compose.
#   ./docker/run.sh              собрать Kali + app и запустить
#   ./docker/run.sh up           то же явно
#   ./docker/run.sh down         остановить app/SearXNG (контейнеры задач не трогаются)
#   ./docker/run.sh status       статус Compose и health
#   ./docker/run.sh logs [svc]   логи
#   ./docker/run.sh knowledge    скачать зафиксированные источники знаний и построить RAG
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$ROOT"

[[ "$(uname -s)" == "Linux" ]] || { echo "Нужен Linux: приложение управляет Kali через host Docker socket." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker не найден." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Нужен Docker Compose v2." >&2; exit 1; }
[[ -S /var/run/docker.sock ]] || { echo "Нет /var/run/docker.sock — запусти Docker daemon." >&2; exit 1; }

export HTB_UID="$(id -u)"
export HTB_GID="$(id -g)"
export DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
export WH_HOST_DATA="$ROOT/data"
export HTB_LLM_PORT="${HTB_LLM_PORT:-7331}"
mkdir -p "$WH_HOST_DATA"

compose=(docker compose)
cmd="${1:-up}"
case "$cmd" in
  up)
    "${compose[@]}" up -d --build app
    printf 'Жду веб-интерфейс'
    for _ in $(seq 1 90); do
      if curl -sf "http://127.0.0.1:${HTB_LLM_PORT}/api/health" >/dev/null 2>&1; then
        printf '\nHTB LLM готов: http://127.0.0.1:%s\n' "$HTB_LLM_PORT"
        exit 0
      fi
      printf '.'
      sleep 2
    done
    printf '\nВеб не поднялся. Смотри: ./docker/run.sh logs app\n' >&2
    exit 1
    ;;
  down)
    "${compose[@]}" down
    echo "Контейнеры задач не останавливались. Посмотреть: docker ps --filter label=whitehat.task"
    ;;
  status)
    "${compose[@]}" ps
    curl -sf "http://127.0.0.1:${HTB_LLM_PORT}/api/health" && echo
    ;;
  logs)
    shift
    "${compose[@]}" logs -f "${1:-app}"
    ;;
  knowledge)
    shift
    # Сначала укажи в веб-настройках рабочий пресеты эмбеддингов: скрипт читает ту же БД настроек.
    "${compose[@]}" exec app node --import tsx scripts/knowledge.mts "$@"
    ;;
  build)
    "${compose[@]}" build kali-image app
    ;;
  *)
    echo "usage: ./docker/run.sh [up|down|status|logs [service]|knowledge [args...]|build]" >&2
    exit 1
    ;;
esac
