// Инструменты агента. Описания — для модели (OpenAI tools), исполнители — здесь же.
// Правило: в контекст идёт КОМПАКТНЫЙ результат, полный — файлом в /work/.whitehat (агент может grep'нуть).
import fs from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Browser } from "playwright-core"; // тип только: рантайм подгружается лениво в renderPageText
import { extractText, getDocumentProxy } from "unpdf";
import { cfg, paths } from "./config.ts";
import * as sandbox from "./sandbox.ts";
import * as library from "./library.ts";
import * as memory from "./memory.ts";
import * as plan from "./plan.ts";
import * as profile from "./profile.ts";
import { exploitHints } from "./exploits.ts";
import * as nmap from "./nmap.ts";
import * as ffuf from "./ffuf.ts";
import * as sqlmap from "./sqlmap.ts";
import * as privesc from "./privesc.ts";
import * as credcheck from "./credcheck.ts";
import { cronChainHint, enumDigest, passwordPromptHint, shellCatchHint } from "./shellhint.ts";
import { subnetCalc } from "./subnet.ts";
import { looksLikeWriteup, SPOILER_BLOCK_TEXT } from "./spoilers.ts";
import { injectionWarning } from "./injection.ts";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Выполнить bash-команду в Kali-контейнере ЭТОЙ задачи (root, рабочая папка /work, есть интернет и NET_ADMIN: iptables, ip link/bridge/veth, tcpdump, tshark, nmap, scapy, dig, curl, man и т.д.). " +
        "Пользователь видит команду и вывод вживую в терминале агента. Длинный вывод обрезается (голова+хвост), полный сохраняется в файл — путь будет в ответе. " +
        "Не обрезай вывод сам через | head: выводы вида «только/все/сколько» делай по полному выводу (grep, wc -l, sort | uniq -c по сохранённому файлу). " +
        "Не запускай бесконечные команды без ограничения (ping без -c, tcpdump без -c/timeout). " +
        "Перед первым запуском специализированной утилиты в чате сверься с её карточкой через search_docs, а при нехватке деталей — с <tool> --help/man в этом же shell; без сверки сервер может не выполнить запуск.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "bash-команда (можно несколько через && или ;)" },
          timeout_sec: { type: "integer", description: `таймаут, по умолчанию ${cfg.defaultCmdTimeoutSec}, максимум ${cfg.maxCmdTimeoutSec}` },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_docs",
      description: "Поиск по библиотеке пользователя (лекции, учебники, заметки) и вложениям задачи. Возвращает фрагменты с источником [файл, страница]. Используй, чтобы опираться на материалы курса и ссылаться на них. Перед специализированной CLI-утилитой ищи здесь её карточку: «<инструмент> использование флаги примеры ошибки» (htb-07-tools).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "что искать (лучше конкретно: термины, протокол, команда)" },
          scope: { type: "string", enum: ["all", "task", "lib"], description: "all — всё (по умолчанию), task — только вложения задачи, lib — только общая библиотека" },
          k: { type: "integer", description: "сколько фрагментов (по умолчанию 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Поиск по подтверждённой памяти: сохранённые шаги, команды, факты, ошибки и результаты. По умолчанию — память этой задачи; all_tasks=true — по всем задачам (как решал похожее раньше).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, all_tasks: { type: "boolean" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Поиск в интернете через собственный SearXNG пользователя (self-hosted метапоиск, без внешних ключей). Используй, когда в search_docs пусто или нужна свежая информация: текущие CVE, методики, официальная документация и релизы инструментов. " +
        "ЗАПРЕЩЕНО искать готовые решения машин и задач (writeups/walkthrough/прохождения HTB и CTF): пользователь решает сам, сервер такие результаты скрывает. Исключение — пользователь прямо попросил показать решение. " +
        "Возвращает пронумерованный список: заголовок, URL, сниппет. По сниппетам выводы не делай — читай страницы через web_fetch. Запрос формулируй конкретно (продукт + версия + CVE/ошибка), можно с оператором site:домен.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "поисковый запрос" },
          k: { type: "integer", description: "сколько результатов показать (по умолчанию 6, максимум 10)" },
          time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "ограничить свежесть выдачи (необязательно)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Скачать публичную страницу по URL и вернуть её текст (HTML очищается до текста: заголовки, абзацы, списки, код из <pre>, ссылки с адресами; поддерживаются PDF и plain text; страницы, которым нужен JavaScript, автоматически дочитываются браузером). Для чтения найденного через web_search: документация, статьи по техникам, Exploit-DB, GitHub. " +
        "Страницы готовых решений машин/задач (writeups/walkthrough HTB и CTF) сервер не отдаёт — пользователь решает сам; не обходи зеркалами и кэшами. " +
        "Не для веба цели по VPN ($TARGET): он доступен только из контейнера — туда ходи shell+curl. Приватные и локальные адреса заблокированы.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "полный http(s) URL страницы" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tcp_probe",
      description:
        "Короткий диалог с TCP-сервисом цели из контейнера: подключение, чтение баннера, отправка строк по шагам и чтение ответов. Для баннеров и простых текстовых протоколов (FTP, SMTP, POP3, Redis, Minecraft handshake, самодельные сервисы) — вместо того чтобы писать python-скрипт ради пары байт. В sends escape-последовательности \\r\\n, \\n, \\t, \\xNN интерпретируются. Для долгой интерактивной сессии (шелл, mysql-клиент) используй job_start, а не это.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "IP или имя цели, например $TARGET или blocky.htb (резолвится внутри контейнера)" },
          port: { type: "integer", description: "TCP-порт" },
          sends: { type: "array", items: { type: "string" }, description: "строки для отправки по очереди, после каждой читается ответ; можно пустой список — только баннер" },
          wait_ms: { type: "integer", description: "сколько ждать ответ на каждом шаге, мс (по умолчанию 2500, максимум 10000)" },
        },
        required: ["host", "port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "HTTP-запрос к вебу цели из контейнера (видит VPN, в отличие от web_fetch) с persistent cookie-сессией задачи: залогинился один раз — следующие вызовы идут авторизованными, без ручного -b/-c и копирования кук. Предпочтительный инструмент для веба цели вместо curl: статус, цепочка редиректов и заголовки — структурно коротко, большое тело — файлом в /work с превью. Разные учётки — разные session (по умолчанию \"default\"); reset_session сбрасывает куки. Для скачивания больших файлов и потоковой экзотики остаётся curl в shell.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "полный URL, например http://blocky.htb/wp-login.php (имена резолвятся внутри контейнера)" },
          method: { type: "string", description: "GET, POST, PUT, DELETE, HEAD... По умолчанию GET, а с form/json/data — POST" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "свои заголовки объект {имя: значение}; куки ставит сессия, вручную Cookie не передавай" },
          form: { type: "object", additionalProperties: { type: "string" }, description: "поля формы application/x-www-form-urlencoded (логины и т.п.)" },
          json: { type: "object", description: "тело JSON-объектом (Content-Type application/json)" },
          data: { type: "string", description: "сырое тело запроса строкой" },
          content_type: { type: "string", description: "Content-Type для сырого data" },
          follow_redirects: { type: "boolean", description: "ходить по редиректам (по умолчанию true); false — увидеть сам 30x и Location" },
          session: { type: "string", description: "имя cookie-сессии задачи; разные имена — разные авторизации" },
          reset_session: { type: "boolean", description: "сбросить куки этой сессии перед запросом" },
          save_to: { type: "string", description: "куда сохранить тело целиком, путь в /work (например scans/index.html); без него большое тело само падает в /work/.whitehat/http/" },
          timeout_sec: { type: "integer", description: "таймаут запроса в секундах (по умолчанию 20, максимум 60)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "nmap_scan",
      description:
        "Сканирование портов цели типизированной обёрткой nmap: сервер сам собирает флаги, запускает скан в контейнере (видно в терминале агента), парсит XML в факты — открытые порты, сервисы и версии структурно, без простыни текста — и записывает сервисы в профиль цели (profile). Это основной инструмент разведки портов; сырой nmap в shell — для особых NSE-скриптов и экзотических флагов (там действует сверка с инструкцией). Полный вывод и XML лежат в /work/scans/. По умолчанию цель задачи $TARGET, топ-1000 TCP-портов с определением версий и -Pn.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "IP, имя хоста или CIDR; пусто — цель задачи ($TARGET)" },
          ports: { type: "string", description: "\"top1000\" (по умолчанию), \"all\" — все 65535, или список вида 22,80,443-445" },
          service_detection: { type: "boolean", description: "-sV: определять сервисы и версии (по умолчанию true)" },
          default_scripts: { type: "boolean", description: "-sC: дефолтные NSE-скрипты (медленнее; по умолчанию false)" },
          scripts: { type: "string", description: "--script: имена/категории NSE через запятую, например http-title,ftp-anon" },
          udp: { type: "boolean", description: "дополнительно UDP top-50 (-sU); заметно медленнее" },
          skip_host_discovery: { type: "boolean", description: "-Pn: не пинговать перед сканом (по умолчанию true — цель известна)" },
          save_profile: { type: "boolean", description: "записать открытые сервисы в профиль цели (по умолчанию true)" },
          timeout_sec: { type: "integer", description: "таймаут скана в секундах (по умолчанию 420, максимум 900)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ffuf_scan",
      description:
        "Фазинг путей и vhost типизированной обёрткой ffuf: сервер собирает флаги, запускает в контейнере и возвращает находки фактами (статус, размер, редирект), а не простынёй прогресса. Режимы: path — FUZZ в URL (нет FUZZ — допишется в конец пути), vhost — Host: FUZZ.домен, при этом базовый размер ответа на несуществующий хост сервер замеряет и фильтрует сам. Словари — пресеты seclists (common по умолчанию, big, raft-medium, api) или свой файл в /work. Полный JSON — в /work/scans/. Сырой ffuf в shell — для кластербомбы, нескольких словарей и экзотики.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "базовый URL; для path — с FUZZ или без (допишется /FUZZ), для vhost — без FUZZ" },
          mode: { type: "string", enum: ["path", "vhost"], description: "path — перебор путей (по умолчанию), vhost — перебор Host-поддоменов" },
          wordlist: { type: "string", description: "пресет common|big|raft-medium|api или путь в /usr/share/seclists/ либо /work/" },
          extensions: { type: "string", description: "расширения через запятую: .php,.bak,.txt" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "заголовки объект {имя: значение}, например Cookie из своей http_request-сессии" },
          match_codes: { type: "string", description: "статусы находок (по умолчанию 200,301,302,307,401,403)" },
          filter_sizes: { type: "string", description: "размеры ответов-исключений через запятую" },
          threads: { type: "integer", description: "потоков (по умолчанию 40)" },
          recursion_depth: { type: "integer", description: "рекурсия по найденным директориям 0..3, только path (по умолчанию 0)" },
          timeout_sec: { type: "integer", description: "таймаут в секундах (по умолчанию 300, максимум 900)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sqlmap_scan",
      description:
        "SQL-инъекции типизированной обёрткой sqlmap по стадиям: detect — поиск инъекции и баннер СУБД, dbs — список баз, tables — таблицы базы, columns — колонки таблицы, dump — строки таблицы (CSV целиком в /work). Сервер собирает команду (всегда --batch), запускает в контейнере, сессия sqlmap сохраняется между стадиями — следующая стадия инъекцию не переищет. Возвращает факты (СУБД, уязвимые параметры и техники, списки, строки), полный лог — в /work/scans/. Найденные креды из дампа записывай в профиль через profile_update. Сырой sqlmap в shell — для --os-shell, tamper-скриптов и экзотики.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL с параметром, например http://machine.htb/item?id=1" },
          stage: { type: "string", enum: ["detect", "dbs", "tables", "columns", "dump"], description: "стадия работы (по умолчанию detect)" },
          data: { type: "string", description: "POST-тело вида a=1&b=2 — параметр ищется и в нём" },
          cookie: { type: "string", description: "Cookie-строка, например из своей http_request-сессии" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "доп. заголовки объект {имя: значение}" },
          db: { type: "string", description: "база для tables/columns/dump (-D)" },
          table: { type: "string", description: "таблица для columns/dump (-T)" },
          level: { type: "integer", description: "уровень тестов 1..5 (по умолчанию 1; выше — больше пейлоадов и дольше)" },
          risk: { type: "integer", description: "риск 1..3 (по умолчанию 1; 2-3 добавляют тяжёлые time-based и OR-пейлоады)" },
          technique: { type: "string", description: "техники буквами BEUSTQ, например BU — только boolean и UNION (быстрее)" },
          threads: { type: "integer", description: "потоков 1..10 (по умолчанию 4)" },
          fresh: { type: "boolean", description: "сбросить сессию sqlmap для этой цели и искать заново" },
          dump_limit: { type: "integer", description: "для dump: не больше стольких строк (--start 1 --stop N)" },
          timeout_sec: { type: "integer", description: "таймаут в секундах (по умолчанию 600, максимум 900)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "privesc_enum",
      description:
        "Локальная энумерация Linux после шелла одним вызовом: сервер отправляет в пойманную сессию (job) бандл чеклиста повышения — id/ОС/ядро, sudo -n -l, SUID, capabilities, cron и /etc/cron.d, systemd-таймеры и incron, процессы, слушающие порты (в т.ч. localhost), записываемое в /etc — дожидается конца и возвращает вывод секциями с выжимкой кандидатов, а связку юзер@хост/ОС записывает фактом в профиль. Начинай PrivEsc с него вместо ручного перебора теми же командами по одной; дальше углубляйся по секциям (цепочки исполнения, GTFOBins). Нужен живой job с шеллом на цели.",
      parameters: {
        type: "object",
        properties: {
          job: { type: "string", description: "id или имя job с пойманным шеллом на цели" },
          timeout_sec: { type: "integer", description: "сколько ждать бандл (по умолчанию 90, максимум 240)" },
        },
        required: ["job"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cred_check",
      description:
        "Проверка одной пары кред (логин + пароль или NTLM-хэш) по сервисам цели через netexec одним вызовом — вместо ручных циклов и «матриц пароль × вход». По умолчанию сервисы берутся из профиля цели по открытым портам (445→smb, 22→ssh, 5985→winrm, 21→ftp, 1433→mssql, 389→ldap, 3389→rdp). Работающие доступы сам записывает кредами в профиль, отказы — фактом «не подходит: …», чтобы пара не проверялась повторно в следующих чатах. Аккуратно с политикой блокировок AD: одна пара за вызов, без спрея по словарям.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "логин; для домена — DOMAIN\\user или user@domain" },
          secret: { type: "string", description: "пароль или NTLM-хэш (с secret_type=hash)" },
          secret_type: { type: "string", enum: ["password", "hash"], description: "password (по умолчанию) или hash — pass-the-hash для smb/winrm/mssql/ldap/rdp" },
          host: { type: "string", description: "IP или имя цели; пусто — $TARGET задачи" },
          services: { type: "array", items: { type: "string" }, description: "протоколы netexec: smb, winrm, ssh, ftp, mssql, ldap, rdp, wmi, vnc; пусто — из профиля по портам" },
        },
        required: ["username", "secret"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_update",
      description:
        "План решения текущей задачи по фазам (Recon, Enumeration, Foothold, User, PrivEsc, Root, PostEx). План видит пользователь в панели «План», а тебе его сводка подклеивается в контекст каждого хода. " +
        "В начале новой машины составь план (action add по пунктам), по мере продвижения отмечай статусы (action update: doing/done/blocked + короткий note с результатом). План — не разрешение выходить за порученный этап, а общая карта, чтобы не терять нить между ходами и чатами.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "remove"], description: "что сделать с планом" },
          id: { type: "string", description: "id пункта (для update/remove; виден в сводке плана)" },
          phase: { type: "string", description: "фаза пункта при add: Recon, Enumeration, Foothold, User, PrivEsc, Root, PostEx" },
          text: { type: "string", description: "текст пункта (для add; при update — новый текст, если надо)" },
          status: { type: "string", enum: ["todo", "doing", "done", "blocked", "skipped"], description: "статус пункта" },
          note: { type: "string", description: "короткий результат/факт по пункту при update (например: найден WP 4.8, креды в конфиге)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "profile_update",
      description:
        "Профиль цели и хранилище кред текущей задачи: сервисы с версиями, найденные креды, полученные доступы и твёрдые факты о машине. Профиль видит пользователь в панели «Цель», а тебе сводка подклеивается в контекст каждого хода — записывай сразу, как узнал, чтобы не терять между ходами и чатами и не пересканировать. " +
        "kind=service: host, port, proto (tcp/udp), service, version. kind=cred: service, username, secret, secret_type (password/hash/key/token), source — ГДЕ нашёл (файл/конфиг/вывод), без источника креды бесполезны при пересоздании контекста. kind=access: text — что за доступ и как получен. kind=fact: text — ОС, хостнейм, домен и т.п. " +
        "Повторный add того же host:port/proto (service) или service+логина (cred) обновляет запись, а не плодит дубль — уточнил версию пересканом, просто добавь снова.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "remove"], description: "что сделать с профилем" },
          id: { type: "string", description: "id записи (для update/remove; виден в сводке профиля)" },
          kind: { type: "string", enum: ["service", "cred", "access", "fact"], description: "тип записи при add" },
          host: { type: "string", description: "IP или имя хоста сервиса (можно пустым, если цель одна)" },
          port: { type: "integer", description: "порт сервиса (обязателен для kind=service)" },
          proto: { type: "string", description: "tcp или udp (по умолчанию tcp)" },
          service: { type: "string", description: "имя сервиса: http, ssh, smb, mysql...; для кред — к какому сервису/приложению они (ssh, wordpress, mysql)" },
          version: { type: "string", description: "версия/баннер сервиса, как в выводе сканера" },
          username: { type: "string", description: "логин для kind=cred" },
          secret: { type: "string", description: "пароль, хэш, приватный ключ или токен для kind=cred" },
          secret_type: { type: "string", description: "тип секрета: password, hash, key, token (по умолчанию password)" },
          source: { type: "string", description: "где найдено: путь к файлу, конфиг, вывод какой команды" },
          text: { type: "string", description: "текст для kind=access/fact" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "subnet_calc",
      description:
        "Точный калькулятор IP-адресации (не считай маски в уме!). IPv4 и IPv6: сеть, broadcast, маска, wildcard, диапазон хостов, количество адресов, тип адреса, двоичный вид. " +
        "Опционально: split_prefix — разбить на подсети такой длины; vlsm_hosts — VLSM-разбиение под список требуемых хостов (от большего к меньшему).",
      parameters: {
        type: "object",
        properties: {
          address: { type: "string", description: "например 192.168.10.37/26, 10.0.0.1 255.255.240.0 или 2001:db8::1/48" },
          split_prefix: { type: "integer" },
          vlsm_hosts: { type: "array", items: { type: "integer" } },
        },
        required: ["address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_history",
      description: "Что ПОЛЬЗОВАТЕЛЬ сам делал в своём терминале этой задачи: последние команды (с временем) и хвост экрана его терминала — вывод и сообщения об ошибках как он их видел. Используй, чтобы понять, что он уже пробовал, и разобрать его ошибки по настоящему выводу.",
      parameters: { type: "object", properties: { limit: { type: "integer", description: "по умолчанию 30" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "job_start",
      description: "Запустить долгоживущую фоновую сессию (tmux) в контейнере задачи: listener reverse shell, http/smb-сервер, интерактивный shell. В отличие от shell, сессия переживает ходы и перезагрузку страницы; после завершения команды остаётся интерактивным bash. Пользователь видит job во вкладке Jobs и может остановить. Не используй для обычных коротких команд — для них shell.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "короткое имя, например listener-4444" },
          command: { type: "string", description: "команда сессии, например nc -lkvp 4444 (с -k листенер продолжает слушать после отключения шелла) или cd /work/www && python3 -m http.server 8000" },
        },
        required: ["name", "command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_list",
      description: "Список фоновых jobs этой задачи и какие из них сейчас запущены.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "job_output",
      description: "Снимок экрана фонового job (tmux capture-pane): что он вывел и что сейчас на экране, включая прилетевший reverse shell.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, lines: { type: "integer", description: "строк истории, по умолчанию 160" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_input",
      description: "Отправить ввод в фоновый job (команду в пойманный reverse shell, ответ интерактивной программе). По умолчанию после текста нажимается Enter. Прервать зависшее в шелле: text=\"^C\" (или настоящий символ \\u0003) и enter=false — буквальный текст «^C» внутри команды клавишей не считается.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" }, enter: { type: "boolean" } },
        required: ["id", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_stop",
      description: "Остановить фоновый job (tmux-сессия и её процессы завершатся; последний вывод сохранится).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_rfc",
      description:
        "Прочитать RFC (кэшируется локально). Без параметров — заголовок и оглавление; section — текст раздела (например '3.1'); " +
        "grep — совпадения: номер строки, номер и название раздела, в котором они стоят, и абзац целиком. " +
        "Цитируя RFC, приводи предложения целиком (не обрывай на полуслове), а номер раздела бери из вывода инструмента, не по памяти.",
      parameters: {
        type: "object",
        properties: { number: { type: "integer" }, section: { type: "string" }, grep: { type: "string" } },
        required: ["number"],
      },
    },
  },
] as const;

export type ToolCtx = {
  taskId: string;
  signal?: AbortSignal;
  emit: (ev: Record<string, unknown>) => void;
  // Политика спойлеров (spoilers.ts): имена текущей задачи для детекта writeups и явное разрешение
  // пользователя на этот ход, посчитанное сервером по его сообщению.
  taskNames?: string[];
  spoilersAllowed?: boolean;
};

// не резать суррогатную пару на краю среза (половинка эмодзи превращается в «�»)
const headOf = (s: string, n: number) => (n > 0 && /[\ud800-\udbff]/.test(s[n - 1] ?? "") ? s.slice(0, n - 1) : s.slice(0, n));
const tailOf = (s: string, n: number) => {
  if (n <= 0) return "";
  const t = s.slice(-n);
  return /^[\udc00-\udfff]/.test(t) ? t.slice(1) : t;
};
// Голова + хвост вместо середины. total — длина всего текста (у вывода команды в памяти только начало и конец).
function compactParts(head: string, tail: string, total: number, max: number, note?: string) {
  if (total <= max) return head;
  const h = headOf(head, Math.floor(max * 0.6));
  const t = tailOf(tail, Math.floor(max * 0.4));
  return `${h}\n…[обрезано ${total - h.length - t.length} символов${note ? `; ${note}` : ""}]…\n${t}`;
}
const compact = (s: string, max: number, note?: string) => compactParts(s, s, s.length, max, note);
// последний экран job, уже отданный модели (дельта поллинга job_output); живёт в памяти процесса сервера
const lastJobScreen = new Map<string, string>();
// Только новые строки экрана с прошлого чтения: общий построчный префикс старого и нового выводов.
// null — экран перерисовался настолько, что честнее отдать его целиком.
// Команда выглядит интерактивной/долгоживущей (идея CAI _looks_interactive): листенер, REPL,
// клиент-сессия или бесконечный поток. В shell-инструменте она умрёт по таймауту и убьёт процесс —
// подсказываем job_start, но не блокируем: короткий прогон с timeout может быть осознанным.
function interactiveHint(command: string): string | null {
  const c = command;
  if (/\b(?:nc|ncat|netcat)\b[^|;&\n]*\s-[a-z]*l/.test(c)) return "листенер (nc -l)";
  if (/\bsocat\b[^|;&\n]*LISTEN/i.test(c)) return "листенер (socat)";
  if (/python3?\s+-m\s+http\.server/.test(c)) return "http-сервер (python -m http.server)";
  if (/\bphp\s+-S\b/.test(c)) return "http-сервер (php -S)";
  if (/\btail\s+(?:-[a-z]*f|--follow)\b/.test(c) || /\bwatch\s/.test(c)) return "бесконечный поток (tail -f/watch)";
  if (/\btcpdump\b/.test(c) && !/\s-c\s*\d+/.test(c)) return "захват трафика без предела пакетов (tcpdump)";
  if (/\bmsfconsole\b/.test(c) && !/\s-x\b/.test(c)) return "интерактивная консоль (msfconsole без -x)";
  if (/(?:^|[;&|\n]\s*)(?:ssh|telnet|ftp|mysql|psql|redis-cli|gdb|radare2|r2)\b/.test(c)) return "интерактивный клиент (ssh/mysql/gdb/…)";
  if (/(?:^|[;&|\n]\s*)python3?\s*(?:$|[;&|])/.test(c)) return "REPL (python без скрипта)";
  return null;
}
// Тип-осознанное сжатие (идея CAI _compress_output_for_model): длинный HTML/JSON/JS из curl —
// самый частый мусор в контексте (curl — лидер вызовов в логах). Модели даём короткое превью
// с пометкой типа; полный вывод и так сохраняется sandbox-ом в /work/.whitehat (путь — в fileNote).
function webAssetKind(head: string): string | null {
  const s = head.slice(0, 4000);
  const t = s.trimStart();
  if (/^<!doctype\s+html/i.test(t) || /^<html[\s>]/i.test(t)) return "HTML";
  if ((s.match(/<[a-z][a-z0-9-]*(\s[^>]*)?>/gi) ?? []).length >= 15) return "HTML";
  if ((t.startsWith("{") || t.startsWith("[")) && /"[^"\n]{1,60}"\s*:/.test(t.slice(0, 500))) return "JSON";
  const lines = s.split("\n");
  const maxLine = Math.max(...lines.map((l) => l.length));
  if (maxLine > 1000 && /(?:function|=>|const\s|var\s|require\(|module\.exports)/.test(s)) return "минифицированный JS/код";
  return null;
}
function jobScreenDelta(prev: string, cur: string): string | null {
  const a = prev.split("\n");
  const b = cur.split("\n");
  let i = 0;
  // строка приглашения совпадает и когда в неё дописан ввод: "root@h$ " -> "root@h$ echo ..."
  while (i < a.length && i < b.length && (a[i] === b[i] || (a[i].trim() !== "" && b[i].startsWith(a[i])))) i++;
  if (i === 0 || i < a.length * 0.5) return null;
  return b.slice(i).join("\n");
}

// Структурный ответ http_request для модели: статус/редиректы/заголовки коротко, тело — превью + файл.
function formatHttp(r: sandbox.HttpResult, url: string): string {
  if (!r.ok) return `ошибка: ${r.error ?? "запрос не выполнен"} (сессия «${r.session}»)`;
  const lines: string[] = [];
  const secs = ((r.elapsed_ms ?? 0) / 1000).toFixed(2);
  lines.push(`HTTP ${r.status}${r.reason ? ` ${r.reason}` : ""} · ${r.method} ${r.final_url ?? url} · ${secs} с · сессия «${r.session}»`);
  if (r.chain?.length) lines.push(`редиректы: ${r.chain.map((c) => `${c.status} ${c.url} -> ${c.location}`).join(" · ")}`);
  const hdrs = (r.headers ?? []).map(([k, v]) => `${k}: ${v}`);
  if (r.set_cookies?.length) hdrs.push(`Set-Cookie: ${r.set_cookies.join(", ")}`);
  if (hdrs.length) lines.push(`заголовки: ${hdrs.join(" · ")}`);
  if (r.jar?.length) lines.push(`куки сессии: ${r.jar.map((c) => `${c.name}@${c.domain}`).join(", ")}`);
  if (r.title) lines.push(`title: ${r.title}`);
  const sizeNote = `тело: ${r.body_len ?? 0} байт${r.content_type ? `, ${r.content_type}` : ""}${r.truncated_download ? " (скачано не целиком, лимит 5 МБ)" : ""}${r.body_saved ? `; целиком: ${r.body_saved}` : ""}`;
  lines.push(sizeNote);
  if (!r.is_text && r.preview) lines.push(`бинарное тело, первые байты hex: ${r.preview}`);
  else if (r.preview) {
    const body = (r.body_len ?? 0) > r.preview.length ? `${r.preview}\n[тело обрезано в превью${r.body_saved ? `, полное: ${r.body_saved}` : ""}]` : r.preview;
    lines.push(`--- тело ---\n${body}`);
  }
  return lines.join("\n");
}

export async function runTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<string> {
  let a: any;
  try { a = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return `ошибка: аргументы не JSON: ${rawArgs.slice(0, 200)}`; }
  try {
    switch (name) {
      case "shell": {
        const command = String(a.command ?? "").trim();
        if (!command) return "ошибка: пустая команда";
        const t = Math.min(cfg.maxCmdTimeoutSec, Math.max(1, Number(a.timeout_sec) || cfg.defaultCmdTimeoutSec));
        const r = await sandbox.runAgentCommand(ctx.taskId, command, t, ctx.signal);
        const o = r.out; // уже очищен: без ESC-последовательностей, \r-прогресс схлопнут
        const fileNote = o.saved ? `полный вывод: ${o.saved} — можно grep/sed${o.savedNote ? ` (${o.savedNote})` : ""}` : o.savedNote;
        // первая строка — статус: интерфейс красит блок по «[exit N» / «[таймаут» / «[прервано».
        // Прерванная пользователем команда честно подписывается прерыванием, а не голым exit 143:
        // 143 = 128+SIGTERM нашего sweep — без подписи выглядит как загадочный сбой самой команды.
        const head = r.timedOut ? `[таймаут ${t} с, процесс остановлен]`
          : r.aborted ? `[прервано: остановлено пользователем, ${r.secs} с]`
          : r.exitCode < 0 ? `[прервано: ${r.note ?? "код возврата неизвестен"}, ${r.secs} с]`
          : `[exit ${r.exitCode}, ${r.secs} с]`;
        const inter = interactiveHint(command);
        const cronHint = cronChainHint(ctx.taskId, "shell", `${o.head}\n${o.tail}`);
        const inj = injectionWarning(`${o.head}\n${o.tail}`);
        const notes = [
          inj ?? "",
          cronHint,
          enumDigest(ctx.taskId, "shell", `${o.head}\n${o.tail}`),
          inter ? `[подсказка: команда похожа на интерактивную/долгоживущую (${inter}). В shell она умрёт по таймауту вместе с процессом — такие вещи запускай через job_start: сессия переживёт ход, ввод — job_input, вывод — job_output]` : "",
          // модель редко сама поднимает timeout_sec: сканы регулярно умирали на дефолтных 90 с (логи чатов)
          r.timedOut && !inter ? "[подсказка: заведомо долгие команды запускай с timeout_sec до 900, а листенеры и интерактивные сессии — через job_start]" : "",
          r.note && r.exitCode >= 0 ? `[${r.note}]` : "",
        ].filter(Boolean).join("\n");
        const assetKind = o.total > cfg.toolOutputChars ? webAssetKind(o.head) : null;
        const body = assetKind
          ? `[вывод похож на ${assetKind} (${o.total} символов) — целиком в контекст не кладу${fileNote ? `; ${fileNote}` : ""}]\nПревью: ${oneLine(o.head.slice(0, 1000)).slice(0, 800)}…`
          : compactParts(o.head, o.tail, o.total, cfg.toolOutputChars, fileNote) || "(пустой вывод)";
        // Авто-обогащение (exploits.ts): версии из вывода скана → кандидаты локального searchsploit
        // прямо в контекст следующего раунда; сам searchsploit и прерванные команды не обогащаем.
        const hints = !/searchsploit/i.test(command) && !r.aborted
          ? await exploitHints(ctx.taskId, `${o.head}\n${o.tail}`).catch(() => "") : "";
        return `${head}\n${notes ? notes + "\n" : ""}${body}${hints ? `\n${hints}` : ""}`;
      }
      case "search_docs": {
        // k от модели — любое число: отрицательный LIMIT в SQLite снимает ограничение, огромный раздувает контекст
        const kk = Math.trunc(Number(a.k));
        const k = kk > 0 ? Math.min(10, kk) : 5; // ≤0, NaN, «abc» — по умолчанию; больше 10 — 10
        const hits = await library.search(String(a.query), ctx.taskId, k, a.scope ?? "all");
        if (!hits.length) return "ничего не найдено (возможно, нужные материалы ещё не загружены в библиотеку)";
        return hits.map(library.fmtHit).join("\n\n---\n\n");
      }
      case "search_memory": {
        // схему никто не проверяет: модель шлёт и "false" строкой — она истинна, и поиск уходил во все задачи
        const all = a.all_tasks === true || String(a.all_tasks ?? "").trim().toLowerCase() === "true";
        const r = await memory.search(String(a.query), all ? null : ctx.taskId);
        if (!r.length) return "в подтверждённой памяти ничего нет";
        return r.map((m) => `- (${all ? `задача «${m.task}», ` : ""}${memory.KIND_RU[m.kind] ?? m.kind}) ${m.title}: ${m.content}`).join("\n");
      }
      case "web_search": {
        const kk = Math.trunc(Number(a.k));
        const k = kk > 0 ? Math.min(10, kk) : 6;
        return await webSearch(String(a.query ?? ""), k, ["day", "week", "month", "year"].includes(a.time_range) ? a.time_range : undefined, ctx);
      }
      case "web_fetch":
        return await webFetch(String(a.url ?? ""), ctx);
      case "tcp_probe": {
        const host = String(a.host ?? "").trim();
        const port = Math.trunc(Number(a.port));
        if (!host || /[\s/\\]/.test(host)) return "ошибка: укажи host одним словом (IP или имя из /etc/hosts контейнера)";
        if (!(port >= 1 && port <= 65535)) return "ошибка: порт должен быть 1..65535";
        const waitMs = Math.min(10_000, Math.max(200, Math.trunc(Number(a.wait_ms)) || 2500));
        const rawSends: unknown[] = Array.isArray(a.sends) ? a.sends.slice(0, 8) : [];
        const steps = rawSends.map((s) => ({ data: decodeEscapes(String(s ?? "")).subarray(0, 8192), waitMs }));
        return await sandbox.tcpProbe(ctx.taskId, host, port, steps, ctx.signal);
      }
      case "http_request": {
        const urlRaw = String(a.url ?? "").trim();
        let url: URL;
        try { url = new URL(urlRaw); } catch { return "ошибка: url должен быть полным, например http://blocky.htb/wp-login.php"; }
        if (url.protocol !== "http:" && url.protocol !== "https:") return "ошибка: только http/https";
        // Политика спойлеров, как у web_fetch: по URL до запроса и по final_url/title/началу тела после.
        if (!ctx.spoilersAllowed && looksLikeWriteup(url.href, ctx.taskNames ?? [])) return SPOILER_BLOCK_TEXT;
        const hasBody = a.form !== undefined || a.json !== undefined || a.data !== undefined;
        const method = String(a.method ?? (hasBody ? "POST" : "GET")).toUpperCase().slice(0, 16);
        const headers: Record<string, string> = {};
        if (a.headers && typeof a.headers === "object")
          for (const [k, v] of Object.entries(a.headers as Record<string, unknown>)) headers[String(k).slice(0, 80)] = String(v).slice(0, 500);
        const form: Record<string, string> | undefined = a.form && typeof a.form === "object"
          ? Object.fromEntries(Object.entries(a.form as Record<string, unknown>).map(([k, v]) => [String(k).slice(0, 200), String(v).slice(0, 4000)])) : undefined;
        const r = await sandbox.httpRequest(ctx.taskId, {
          method, url: url.href, headers,
          data: a.data !== undefined ? String(a.data).slice(0, 64_000) : undefined,
          form, json: a.json,
          contentType: a.content_type ? String(a.content_type).slice(0, 120) : undefined,
          follow: a.follow_redirects !== false,
          session: a.session ? String(a.session).slice(0, 40) : undefined,
          resetSession: a.reset_session === true,
          saveTo: a.save_to ? String(a.save_to).slice(0, 300) : undefined,
          timeoutSec: Math.trunc(Number(a.timeout_sec)) || undefined,
        }, ctx.signal);
        if (r.ok && !ctx.spoilersAllowed && looksLikeWriteup(`${r.final_url ?? ""} ${r.title ?? ""} ${(r.preview ?? "").slice(0, 2000)}`, ctx.taskNames ?? [])) {
          // тело уже скачано в контейнер — убрать файл, чтобы модель не дочитала его cat-ом
          if (r.body_saved && /^\/work\/[A-Za-z0-9_./-]+$/.test(r.body_saved) && !r.body_saved.includes(".."))
            await sandbox.execCollect(ctx.taskId, `rm -f -- '${r.body_saved}'`, 10).catch(() => {});
          return SPOILER_BLOCK_TEXT;
        }
        const out = formatHttp(r, url.href);
        const inj = r.ok && r.preview ? injectionWarning(r.preview) : null;
        // Авто-обогащение по баннерам ответа (Server, X-Powered-By, генератор CMS в начале тела)
        const hints = r.ok
          ? await exploitHints(ctx.taskId, `${(r.headers ?? []).map(([k, v]) => `${k}: ${v}`).join("\n")}\n${r.preview ?? ""}`).catch(() => "") : "";
        return `${out}${hints ? `\n${hints}` : ""}${inj ? `\n${inj}` : ""}`;
      }
      case "nmap_scan": {
        const truthy = (v: unknown) => v === true || String(v ?? "").trim().toLowerCase() === "true";
        const notFalse = (v: unknown) => v !== false && String(v ?? "").trim().toLowerCase() !== "false";
        const opts: nmap.NmapOpts = {
          target: a.target ? String(a.target).trim() : undefined,
          ports: a.ports ? String(a.ports).trim() : undefined,
          serviceDetection: notFalse(a.service_detection),
          defaultScripts: truthy(a.default_scripts),
          scripts: a.scripts ? String(a.scripts).trim() : undefined,
          udp: truthy(a.udp),
          skipHostDiscovery: notFalse(a.skip_host_discovery),
          timeoutSec: Math.trunc(Number(a.timeout_sec)) || undefined,
        };
        const bad = nmap.validateNmapOpts(opts);
        if (bad) return `ошибка: ${bad}`;
        const r = await nmap.runNmapScan(ctx.taskId, opts, ctx.signal);
        let saved: number | null = null;
        if (r.ok && notFalse(a.save_profile)) {
          saved = 0;
          for (const h of r.hosts) for (const p of h.ports) {
            if (p.state !== "open") continue;
            try {
              profile.addProfileItem(ctx.taskId, "service", {
                host: h.addr, port: p.port, proto: p.proto, service: p.service,
                version: nmap.serviceVersion(p), source: `nmap_scan ${r.txtPath}`,
              });
              saved++;
            } catch { /* одна битая запись не валит скан */ }
          }
        }
        const out = nmap.formatNmap(r, saved);
        if (!r.ok) return out;
        const hintText = r.hosts.flatMap((h) => h.ports.filter((p) => p.state === "open")
          .map((p) => `${p.port}/${p.proto} open ${p.service} ${nmap.serviceVersion(p)}`)).join("\n");
        const hints = await exploitHints(ctx.taskId, hintText).catch(() => "");
        const inj = injectionWarning(out);
        return `${out}${hints ? `\n${hints}` : ""}${inj ? `\n${inj}` : ""}`;
      }
      case "ffuf_scan": {
        const urlRaw = String(a.url ?? "").trim();
        if (!ctx.spoilersAllowed && looksLikeWriteup(urlRaw, ctx.taskNames ?? [])) return SPOILER_BLOCK_TEXT;
        const headers: Record<string, string> = {};
        if (a.headers && typeof a.headers === "object")
          for (const [k, v] of Object.entries(a.headers as Record<string, unknown>)) headers[String(k).slice(0, 80)] = String(v).slice(0, 500);
        const opts: ffuf.FfufOpts = {
          url: urlRaw,
          mode: a.mode === "vhost" ? "vhost" : "path",
          wordlist: a.wordlist ? String(a.wordlist).trim() : undefined,
          extensions: a.extensions ? String(a.extensions).trim() : undefined,
          headers,
          matchCodes: a.match_codes ? String(a.match_codes).trim() : undefined,
          filterSizes: a.filter_sizes ? String(a.filter_sizes).trim() : undefined,
          threads: Math.trunc(Number(a.threads)) || undefined,
          recursionDepth: Math.trunc(Number(a.recursion_depth)) || undefined,
          timeoutSec: Math.trunc(Number(a.timeout_sec)) || undefined,
        };
        const bad = ffuf.validateFfufOpts(opts);
        if (bad) return `ошибка: ${bad}`;
        const r = await ffuf.runFfuf(ctx.taskId, opts, ctx.signal);
        return ffuf.formatFfuf(r);
      }
      case "sqlmap_scan": {
        const urlRaw = String(a.url ?? "").trim();
        if (!ctx.spoilersAllowed && looksLikeWriteup(urlRaw, ctx.taskNames ?? [])) return SPOILER_BLOCK_TEXT;
        const headers: Record<string, string> = {};
        if (a.headers && typeof a.headers === "object")
          for (const [k, v] of Object.entries(a.headers as Record<string, unknown>)) headers[String(k).slice(0, 80)] = String(v).slice(0, 500);
        const stages = ["detect", "dbs", "tables", "columns", "dump"] as const;
        const opts: sqlmap.SqlmapOpts = {
          url: urlRaw,
          stage: stages.includes(a.stage as any) ? (a.stage as sqlmap.SqlmapStage) : "detect",
          data: a.data ? String(a.data) : undefined,
          cookie: a.cookie ? String(a.cookie) : undefined,
          headers,
          db: a.db ? String(a.db).trim() : undefined,
          table: a.table ? String(a.table).trim() : undefined,
          level: Math.trunc(Number(a.level)) || undefined,
          risk: Math.trunc(Number(a.risk)) || undefined,
          technique: a.technique ? String(a.technique).trim() : undefined,
          threads: Math.trunc(Number(a.threads)) || undefined,
          fresh: a.fresh === true || String(a.fresh ?? "").trim().toLowerCase() === "true",
          dumpLimit: Math.trunc(Number(a.dump_limit)) || undefined,
          timeoutSec: Math.trunc(Number(a.timeout_sec)) || undefined,
        };
        const bad = sqlmap.validateSqlmapOpts(opts);
        if (bad) return `ошибка: ${bad}`;
        const r = await sqlmap.runSqlmap(ctx.taskId, opts, ctx.signal);
        const out = sqlmap.formatSqlmap(r);
        const inj = r.ok ? injectionWarning(out) : null;
        return inj ? `${out}\n${inj}` : out;
      }
      case "privesc_enum": {
        const r = await privesc.runPrivescEnum(ctx.taskId, String(a.job ?? ""), Math.trunc(Number(a.timeout_sec)) || undefined, ctx.signal);
        if (!r.ok) return `ошибка: ${r.error}`;
        const inj = injectionWarning(r.text);
        return inj ? `${r.text}\n${inj}` : r.text;
      }
      case "cred_check": {
        const opts: credcheck.CredCheckOpts = {
          host: a.host ? String(a.host).trim() : undefined,
          username: String(a.username ?? ""),
          secret: String(a.secret ?? ""),
          secretType: a.secret_type ? String(a.secret_type) : undefined,
          services: Array.isArray(a.services) ? a.services.map((s: unknown) => String(s)) : undefined,
        };
        const bad = credcheck.validateCredOpts(opts);
        if (bad) return `ошибка: ${bad}`;
        const r = await credcheck.runCredCheck(ctx.taskId, opts, ctx.signal);
        const out = credcheck.formatCredCheck(r, opts.username);
        const inj = r.ok ? injectionWarning(out) : null;
        return inj ? `${out}\n${inj}` : out;
      }
      case "plan_update": {
        const action = String(a.action ?? "");
        if (action === "add") plan.addPlanItem(ctx.taskId, a.phase, a.text, a.status);
        else if (action === "update") plan.updatePlanItem(ctx.taskId, String(a.id ?? ""), { status: a.status, note: a.note, text: a.text, phase: a.phase });
        else if (action === "remove") plan.removePlanItem(ctx.taskId, String(a.id ?? ""));
        else return "ошибка: action должен быть add, update или remove";
        return `План задачи обновлён.\n${plan.formatPlan(plan.listPlan(ctx.taskId))}`;
      }
      case "profile_update": {
        const action = String(a.action ?? "");
        const fields = {
          host: a.host, port: a.port, proto: a.proto, service: a.service, version: a.version,
          username: a.username, secret: a.secret, secret_type: a.secret_type, source: a.source, text: a.text, kind: a.kind,
        };
        if (action === "add") profile.addProfileItem(ctx.taskId, a.kind, fields);
        else if (action === "update") profile.updateProfileItem(ctx.taskId, String(a.id ?? ""), fields);
        else if (action === "remove") profile.removeProfileItem(ctx.taskId, String(a.id ?? ""));
        else return "ошибка: action должен быть add, update или remove";
        return `Профиль цели обновлён.\n${profile.formatProfile(profile.listProfile(ctx.taskId))}`;
      }
      case "subnet_calc":
        return subnetCalc(String(a.address), a.split_prefix, a.vlsm_hosts);
      case "user_history": {
        const h = await sandbox.userHistory(ctx.taskId, Math.min(200, Number(a.limit) || 30));
        const screen = await sandbox.userTerminalScreen(ctx.taskId);
        if (!h.length && !screen) return "пользователь ещё не вводил команд в своём терминале";
        const cmds = h.map((x) => `${x.ts ? new Date(x.ts).toLocaleTimeString("ru-RU") : "--:--:--"}  ${x.cmd}`).join("\n");
        return `КОМАНДЫ (история bash):\n${cmds || "(пусто)"}\n\nЭКРАН ТЕРМИНАЛА ПОЛЬЗОВАТЕЛЯ (последнее, вывод и ошибки как он их видел):\n${screen || "(терминал в этом запуске сервера не открывался)"}`;
      }
      case "job_start": {
        const job = await sandbox.createJob(ctx.taskId, String(a.name ?? ""), String(a.command ?? ""));
        return `job ${job.id} «${job.name}» запущен (tmux-сессия ${sandbox.jobSessionName(job.id)}). Вывод — job_output, ввод — job_input, остановка — job_stop. Команда: ${job.command}`;
      }
      case "job_list": {
        const list = await sandbox.listJobs(ctx.taskId);
        if (!list.length) return "фоновых jobs у этой задачи нет";
        return list.map((j) => `- ${j.id} «${j.name}» ${j.running ? "запущен" : "остановлен"}: ${j.command}`).join("\n");
      }
      case "job_output": {
        const r = await sandbox.jobOutput(ctx.taskId, String(a.id ?? ""), Number(a.lines) || 160);
        // Полный экран при каждом поллинге съедал контекст и раунды (job_output — самый частый вызов
        // после shell, job_input при этом почти не использовался). Отдаём только новое с прошлого чтения
        // (паттерн get_new_output из CAI/EnIGMA); неизменный экран — одной строкой-направлением.
        const key = `${ctx.taskId}:${r.job.id}`;
        const head = `[job ${r.job.id} «${r.job.name}» ${r.job.running ? "запущен" : "остановлен"}]`;
        const prev = lastJobScreen.get(key);
        lastJobScreen.set(key, r.output);
        let body: string;
        let fresh = ""; // текст, которого агент ещё не видел: по нему ловим прилёт reverse shell
        const delta = r.job.running && prev ? jobScreenDelta(prev, r.output) : null;
        if (r.job.running && prev !== undefined && prev === r.output) {
          body = `${head} экран без изменений с прошлого job_output — не полли впустую: отправь ввод через job_input или займись другим шагом.`;
        } else if (delta !== null) {
          fresh = delta;
          body = delta.trim()
            ? `${head} (только новое с прошлого job_output)\n${compact(delta, cfg.toolOutputChars)}`
            : `${head} экран без изменений с прошлого job_output — не полли впустую: отправь ввод через job_input или займись другим шагом.`;
        } else {
          fresh = prev === undefined ? r.output : r.output.slice(-4000);
          body = `${head}\n${compact(r.output || "(пока пусто)", cfg.toolOutputChars)}`;
        }
        // Детект пойманного reverse shell (shellhint.ts): подсказка один раз на подключение.
        const hint = r.job.running && fresh ? shellCatchHint(ctx.taskId, r.job, fresh) : "";
        // Зависший промпт пароля: следующая обычная команда сгорит как попытка пароля.
        const pwHint = r.job.running ? passwordPromptHint(ctx.taskId, r.job, r.output) : "";
        // Задача расписания в свежем выводе: напомнить про цепочку исполнения до экзотики.
        const cronHint = r.job.running && fresh ? cronChainHint(ctx.taskId, `job:${r.job.id}`, fresh) : "";
        // Выжимка энумерации по полному экрану: кандидаты на векторы, только новые строки.
        const digest = r.job.running ? enumDigest(ctx.taskId, `job:${r.job.id}`, r.output) : "";
        // Диагностика листенера: мёртвое соединение/очередь backlog — иначе модель поллит пустой экран.
        const diag = r.job.running ? await sandbox.jobListenerDiag(ctx.taskId, r.job.id).catch(() => "") : "";
        return [body, hint, pwHint, cronHint, digest, diag].filter(Boolean).join("\n");
      }
      case "job_input": {
        const enter = a.enter !== false && String(a.enter ?? "").toLowerCase() !== "false";
        const job = await sandbox.jobInput(ctx.taskId, String(a.id ?? ""), String(a.text ?? ""), enter);
        return `ввод отправлен в job ${job.id} «${job.name}»; результат смотри job_output`;
      }
      case "job_stop": {
        const job = await sandbox.stopJob(ctx.taskId, String(a.id ?? ""));
        return `job ${job.id} «${job.name}» остановлен; последний вывод доступен через job_output`;
      }
      case "read_rfc":
        return await readRfc(Number(a.number), a.section, a.grep);
      case "spawn_subagent":
        // выполняется сервером хода (graph.toolsNode запускает вложенный цикл); сюда попасть нельзя
        return "ошибка: spawn_subagent выполняется сервером хода, а не напрямую";
      default:
        return `ошибка: неизвестный инструмент ${name}`;
    }
  } catch (e: any) {
    return `ошибка инструмента ${name}: ${e?.message ?? e}`;
  }
}

// Текст RFC без колонтитулов страниц, страницы склеены. Старые RFC (791): вверху «September 1981 / Internet Protocol /
// Introduction», внизу «[Page 1]»; новые постраничные: «RFC 2616  HTTP/1.1  June 1999» и «Fielding, et al. … [Page 5]».
const MONTH = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/;
function rfcText(raw: string) {
  const pages = raw.replace(/\r\n?/g, "\n").split("\f");
  let out: string[] = [];
  pages.forEach((pg, i) => {
    let ls = pg.split("\n");
    let e = ls.length;
    while (e > 0 && !ls[e - 1].trim()) e--;
    if (e > 0 && /\[Page [0-9ivxlc]+\]\s*$/i.test(ls[e - 1])) { e--; while (e > 0 && !ls[e - 1].trim()) e--; }
    ls = ls.slice(0, e);
    let b = 0;
    while (b < ls.length && !ls[b].trim()) b++;
    if (i > 0) {
      let h = b;
      while (h < ls.length && ls[h].trim() && h - b < 4) h++;
      const group = ls.slice(b, h).join("\n");
      if (h > b && (h >= ls.length || !ls[h].trim()) && (/RFC \d+/.test(group) || MONTH.test(group))) {
        b = h;
        while (b < ls.length && !ls[b].trim()) b++;
      }
    }
    ls = ls.slice(b);
    if (!ls.length) return;
    if (out.length) {
      // абзац, разорванный страницей, склеивается; конец предложения или заголовок — граница абзаца
      const prev = out[out.length - 1];
      if (/[.:;)]\s*$/.test(prev) || isHeading(ls[0])) out.push("");
    }
    out = out.concat(ls);
  });
  return out.join("\n");
}
// Заголовок раздела в RFC — строка с первой колонки (текст набран с отступом); строки оглавления с «.....» не в счёт.
const isHeading = (l: string) => /^\S/.test(l) && !/\.{4,}\s*\d+\s*$/.test(l);
function headingParts(l: string) {
  const m = /^(?:Appendix\s+)?(\d+(?:\.\d+)*\.?|[A-Z]\.(?:\d+\.?)*)\s+(\S.*)$/.exec(l.trim());
  return m ? { num: m[1].replace(/\.$/, ""), title: m[2].trim() } : { num: "", title: l.trim() };
}

async function readRfc(n: number, section?: string, grep?: string) {
  if (!Number.isInteger(n) || n <= 0) return "ошибка: номер RFC";
  const f = path.join(paths.rfcCache, `rfc${n}.txt`);
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://www.rfc-editor.org/rfc/rfc${n}.txt`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return `RFC ${n} не найден (${r.status})`;
    fs.writeFileSync(f, await r.text());
  }
  const text = rfcText(fs.readFileSync(f, "utf8"));
  const lines = text.split("\n");
  if (grep) {
    const re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    // раздел каждой строки: ближайший заголовок выше
    const sec: number[] = [];
    let cur = -1;
    lines.forEach((l, i) => { if (isHeading(l)) cur = i; sec.push(cur); });
    const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (!hits.length) return `в RFC ${n} нет «${grep}»`;
    // совпадение -> абзац целиком (от пустой строки до пустой строки, заголовок начинает новый абзац)
    const blocks: { a: number; b: number; hits: number[] }[] = [];
    for (const i of hits) {
      const last = blocks[blocks.length - 1];
      if (last && i <= last.b) { last.hits.push(i); continue; }
      let a = i, b = i;
      while (a > 0 && lines[a - 1].trim() && !isHeading(lines[a])) a--;
      while (b + 1 < lines.length && lines[b + 1].trim() && !isHeading(lines[b + 1])) b++;
      // одиночная строка-подзаголовок («Time to Live:  8 bits») — к ней следующий абзац с описанием
      if (a === b && b + 2 < lines.length && !lines[b + 1].trim() && lines[b + 2].trim() && !isHeading(lines[b + 2])) {
        b += 2;
        while (b + 1 < lines.length && lines[b + 1].trim() && !isHeading(lines[b + 1])) b++;
      }
      if (b - a > 40) { a = Math.max(a, i - 15); b = Math.min(b, i + 15); } // огромная таблица/рисунок — окно вокруг
      blocks.push({ a, b, hits: [i] });
    }
    const BUDGET = 5500;
    const out: string[] = [];
    let size = 0, shown = 0;
    for (const bl of blocks) {
      const h = sec[bl.a] >= 0 ? headingParts(lines[sec[bl.a]]) : null;
      const where = h ? (h.num ? `раздел ${h.num} «${h.title}»` : `раздел «${h.title}»`) : "начало документа (до первого раздела)";
      const lineNos = bl.hits.length > 1 ? ` (совпадения в строках ${bl.hits.map((x) => x + 1).join(", ")})` : "";
      const piece = `${bl.hits[0] + 1}: ${where}${lineNos}\n${lines.slice(bl.a, bl.b + 1).join("\n")}`;
      if (shown && size + piece.length > BUDGET) break;
      out.push(piece.length > BUDGET ? compact(piece, BUDGET) : piece);
      size += piece.length + 2;
      shown++;
    }
    if (shown < blocks.length) {
      const rest = blocks.slice(shown).reduce((s, b) => s + b.hits.length, 0);
      out.push(`…[ещё ${rest} совпадений в ${blocks.length - shown} абзацах не показано — уточни grep или прочитай раздел через section]`);
    }
    return out.join("\n\n");
  }
  if (section) {
    const s = section.trim().replace(/^§/, "").replace(/\.$/, "");
    const start = lines.findIndex((l) => isHeading(l) && new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s+\\S`).test(l));
    if (start < 0) return `раздел ${section} не найден; вызови без section, чтобы увидеть оглавление`;
    const depth = s.split(".").length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = isHeading(lines[i]) && /^(\d+(?:\.\d+)*)\.?\s+\S/.exec(lines[i]);
      if (m && m[1].split(".").length <= depth) { end = i; break; }
    }
    return compact(lines.slice(start, end).join("\n"), 6000);
  }
  const toc = text.search(/Table of Contents/i);
  const headEnd = toc > 0 ? toc : 1500;
  return compact(text.slice(0, Math.min(headEnd, 1500)) + (toc > 0 ? "\n" + text.slice(toc, toc + 4000) : ""), 5500);
}

// ---------- интернет: поиск (SearXNG пользователя) и чтение страниц ----------
const WEB_UA = "htb-llm/0.1 (unofficial local self-hosted assistant)";
// Таймаут + внешняя отмена хода (кнопка «стоп») одним сигналом.
function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
// Escape-последовательности модели в отправляемых байтах tcp_probe: \r\n \n \t \\ и \xNN.
function decodeEscapes(s: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const c = s[++i];
      if (c === "n") { bytes.push(10); continue; }
      if (c === "r") { bytes.push(13); continue; }
      if (c === "t") { bytes.push(9); continue; }
      if (c === "0") { bytes.push(0); continue; }
      if (c === "\\") { bytes.push(92); continue; }
      if (c === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; continue; }
      bytes.push(92);
    }
    for (const b of Buffer.from(s[i], "utf8")) bytes.push(b);
  }
  return Buffer.from(bytes);
}

async function webSearch(query: string, k: number, timeRange: string | undefined, ctx: ToolCtx): Promise<string> {
  const outer = ctx.signal;
  const q = query.trim();
  if (!q) return "ошибка: пустой поисковый запрос";
  const params = new URLSearchParams({ q, format: "json", pageno: "1", language: "auto" });
  if (timeRange) params.set("time_range", timeRange);
  let r: Response;
  try {
    r = await fetch(`${cfg.searxngUrl}/search?${params}`, {
      headers: { "User-Agent": WEB_UA, Accept: "application/json" },
      signal: timeoutSignal(30_000, outer), // метапоиск опрашивает движки — бывает 10-20 с
    });
  } catch (e: any) {
    if (outer?.aborted) return "ошибка: поиск прерван пользователем";
    return `ошибка: веб-поиск недоступен — SearXNG (${cfg.searxngUrl}) не отвечает (${e?.message ?? e}). Сообщи пользователю, что нужно поднять его SearXNG, и продолжай без веба: search_docs, man/--help.`;
  }
  if (r.status === 403) return "ошибка: SearXNG отказал в JSON-выдаче (403) — в его settings.yml в search.formats должен быть json. Сообщи пользователю и продолжай без веба.";
  if (!r.ok) return `ошибка: SearXNG вернул HTTP ${r.status} на запрос «${q}»`;
  const data: any = await r.json().catch(() => null);
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) {
    const dead: any[] = Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : [];
    const note = dead.length ? ` Движки не ответили: ${dead.slice(0, 4).map((e) => String(Array.isArray(e) ? e[0] : e)).join(", ")} — возможно, лимиты поисковиков; попробуй другой запрос позже.` : "";
    return `ничего не найдено по запросу «${q}» (веб-поиск SearXNG).${note}`;
  }
  // Политика спойлеров: готовые решения (writeups/walkthrough) из выдачи убираем целиком, без URL,
  // чтобы не было ни соблазна, ни обхода. Скрытое честно называем количеством.
  let hidden = 0;
  let pool = results;
  if (!ctx.spoilersAllowed) {
    pool = results.filter((x) => !looksLikeWriteup(`${String(x?.url ?? "")} ${String(x?.title ?? "")} ${String(x?.content ?? "")}`, ctx.taskNames ?? []));
    hidden = results.length - pool.length;
    if (!pool.length) return `ничего не найдено по запросу «${q}» (веб-поиск SearXNG): все ${results.length} результатов похожи на готовые решения/writeups и скрыты политикой обучения. Переформулируй запрос на технический: сервис, версия, CVE, инструмент, методика. Решения откроются, только если пользователь сам прямо попросит их показать.`;
  }
  const shown = pool.slice(0, k);
  const lines = shown.map((x, i) => {
    const title = oneLine(String(x?.title ?? "(без заголовка)"));
    const date = typeof x?.publishedDate === "string" && x.publishedDate ? ` [${x.publishedDate.slice(0, 10)}]` : "";
    const snippet = compact(oneLine(String(x?.content ?? "")), 280);
    return `${i + 1}. ${title}${date}\n   ${String(x?.url ?? "")}${snippet ? `\n   ${snippet}` : ""}`;
  });
  const total = Number(data?.number_of_results) || results.length;
  const hiddenNote = hidden ? `\n\nСкрыто результатов: ${hidden} (похоже на writeups/готовые решения задач — политикой обучения недоступны; откроются, только если пользователь сам прямо попросит показать решение). Не пытайся найти их другими запросами или зеркалами.` : "";
  return `Веб-поиск (SearXNG) «${q}» — показано ${shown.length} из ${total}:\n${lines.join("\n")}\n\nПолные страницы читай через web_fetch; выводы по одним сниппетам не делай.${hiddenNote}`;
}

// SSRF-гард web_fetch: сервер ходит за страницами сам, поэтому loopback/приватные/соседние адреса
// (наш API, llama-server, qdrant, docker-сети, VPN цели) недоступны — для них у модели есть shell.
function isPrivateIp(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip); // v4 внутри v6
  if (mapped) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 51)) || (a === 203 && b === 0) || a >= 224;
  }
  if (isIP(ip) === 6) {
    const lo = ip.toLowerCase();
    return lo === "::1" || lo === "::" || lo.startsWith("fe8") || lo.startsWith("fe9") || lo.startsWith("fea") || lo.startsWith("feb")
      || lo.startsWith("fc") || lo.startsWith("fd") || lo.startsWith("ff");
  }
  return true; // не IP и не распознался — считаем опасным
}
async function assertPublicUrl(u: URL): Promise<string | null> {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `поддерживаются только http(s) URL, а не ${u.protocol}`;
  if (cfg.webAllowPrivate) return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return `локальное имя ${host} заблокировано`;
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    if (!addrs.length) return `имя ${host} не разрешается в DNS`;
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad) return `${host} указывает на недоступный адрес ${bad.address} (loopback/приватные сети web_fetch запрещены; веб цели по VPN читай через shell и curl из контейнера)`;
  } catch (e: any) {
    return `DNS для ${host}: ${e?.message ?? e}`;
  }
  return null;
}
// Тело ответа с жёстким пределом: страница может быть огромной, контекст у модели не резиновый.
async function readBodyLimited(r: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const reader = r.body?.getReader();
  if (!reader) { const ab = await r.arrayBuffer(); return { buf: Buffer.from(ab.slice(0, maxBytes)), truncated: ab.byteLength > maxBytes }; }
  const parts: Uint8Array[] = [];
  let total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { parts.push(value.slice(0, value.byteLength - (total - maxBytes))); truncated = true; await reader.cancel().catch(() => {}); break; }
      parts.push(value);
    }
  }
  return { buf: Buffer.concat(parts), truncated };
}

async function webFetch(rawUrl: string, ctx: ToolCtx): Promise<string> {
  const outer = ctx.signal;
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { return `ошибка: не URL: ${rawUrl.slice(0, 200)}`; }
  // Политика спойлеров: райтап по URL не качаем вовсе; каждый редирект проверяется заново ниже.
  if (!ctx.spoilersAllowed && looksLikeWriteup(url.href, ctx.taskNames ?? [])) return SPOILER_BLOCK_TEXT;
  const signal = timeoutSignal(30_000, outer);
  let r: Response | null = null;
  for (let hop = 0; hop <= 5; hop++) {
    const blocked = await assertPublicUrl(url);
    if (blocked) return `ошибка: ${blocked}`;
    if (!ctx.spoilersAllowed && looksLikeWriteup(url.href, ctx.taskNames ?? [])) return SPOILER_BLOCK_TEXT;
    try {
      r = await fetch(url, { headers: { "User-Agent": WEB_UA, Accept: "text/html,application/xhtml+xml,text/plain,application/pdf,*/*;q=0.5" }, redirect: "manual", signal });
    } catch (e: any) {
      if (outer?.aborted) return "ошибка: загрузка прервана пользователем";
      return `ошибка: страница не загрузилась (${e?.message ?? e}) — ${url.href}`;
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) break;
      if (hop === 5) return `ошибка: слишком много перенаправлений (>5) у ${rawUrl}`;
      await r.body?.cancel().catch(() => {});
      try { url = new URL(loc, url); } catch { return `ошибка: битое перенаправление на ${loc.slice(0, 200)}`; }
      continue;
    }
    break;
  }
  if (!r) return "ошибка: пустой ответ сервера";
  if (!r.ok) return `ошибка: HTTP ${r.status} ${r.statusText} — ${url.href}`;
  const ct = (r.headers.get("content-type") ?? "").toLowerCase();
  const { buf, truncated } = await readBodyLimited(r, 2_000_000);
  const sizeNote = truncated ? "страница больше 2 МБ — прочитаны первые 2 МБ; целиком: скачай через shell (curl) и ищи grep-ом" : undefined;
  let title = "", text: string, rendered = false;
  if (ct.includes("application/pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const res = await extractText(pdf, { mergePages: true });
      text = Array.isArray(res.text) ? res.text.join("\n") : String(res.text ?? "");
      title = `PDF (${res.totalPages ?? "?"} с.)`;
    } catch (e: any) { return `ошибка: PDF не прочитался (${e?.message ?? e}) — ${url.href}`; }
  } else if (ct.includes("text/html") || ct.includes("application/xhtml") || (!ct && /<html[\s>]/i.test(buf.toString("utf8", 0, 512)))) {
    const conv = htmlToText(buf.toString("utf8"), url);
    title = conv.title;
    text = conv.text;
    // Пустой каркас (<200 значащих символов) — вероятно SPA: дочитываем настоящим браузером.
    if (text.replace(/\s+/g, "").length < 200) {
      const rr = await renderPageText(url, ctx).catch(() => null);
      if (rr && rr.text.replace(/\s+/g, "").length > text.replace(/\s+/g, "").length) {
        title = rr.title || title;
        text = rr.text;
        url = rr.finalUrl;
        rendered = true;
      }
    }
  } else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("markdown") || ct.includes("yaml") || !ct) {
    text = buf.toString("utf8");
  } else {
    return `ошибка: тип содержимого ${ct.split(";")[0]} не поддерживается (нужны HTML, текст или PDF) — ${url.href}`;
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return `ошибка: на странице не нашлось текста${cfg.webRender ? " даже после отрисовки в браузере" : " (возможно, нужен JavaScript, а отрисовка браузером отключена WH_WEB_RENDER=off)"} — ${url.href}`;
  // Вторая линия политики спойлеров: URL мог быть нейтральным, а заголовок/начало — райтапом.
  // Текст уже скачан, но модели он не уходит.
  if (!ctx.spoilersAllowed && looksLikeWriteup(`${url.href} ${title} ${text.slice(0, 2000)}`, ctx.taskNames ?? [])) return SPOILER_BLOCK_TEXT;
  const inj = injectionWarning(`${title}\n${text}`);
  const head = (title ? `[${oneLine(title)} — ${url.href}]` : `[${url.href}]`) + (rendered ? " (страница отрисована браузером: ей нужен JavaScript)" : "");
  return `${inj ? `${inj}\n` : ""}${head}\n${compact(text, cfg.toolOutputChars, sizeNote ?? "страница длинная — целиком: shell + curl в файл и grep по нему")}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&"); // &amp; — последним, иначе &amp;lt; превратится в <
}
// Основной контент: шапки/меню больших сайтов (GitHub!) съедают начало текста, поэтому предпочитаем
// самый длинный <article>, затем <main>. Жадный матч main — он один и в себя не вкладывается.
function mainContent(html: string): string {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1]).sort((a, b) => b.length - a.length);
  if (articles[0] && articles[0].length >= 3000) return articles[0];
  const main = /<main\b[^>]*>([\s\S]*)<\/main\s*>/i.exec(html)?.[1];
  if (main && main.length >= html.length * 0.25) return main;
  return articles[0] ?? main ?? html;
}
// HTML -> читаемый текст без тяжёлых зависимостей: структура (заголовки/абзацы/списки/таблицы),
// код из <pre> дословно, у ссылок сохраняется абсолютный адрес — модель может идти дальше web_fetch.
function htmlToText(html: string, base: URL): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|nav|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, " ");
  s = mainContent(s);
  // <pre> прячем до общей чистки: внутри него теги и пробелы значимы
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner) => {
    const code = decodeEntities(String(inner).replace(/<[^>]+>/g, "")).replace(/^\n+|\s+$/g, "");
    pres.push(code);
    return `\n\n\u0000PRE${pres.length - 1}\u0000\n\n`;
  });
  s = s.replace(/<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, hrefRaw, inner) => {
    const href = String(hrefRaw).replace(/^['"]|['"]$/g, "").trim();
    const text = oneLine(decodeEntities(String(inner).replace(/<[^>]+>/g, " ")));
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) return text;
    let abs: string;
    try { abs = new URL(href, base).href; } catch { return text; }
    return text && text !== abs ? `${text} (${abs})` : abs;
  });
  s = s
    .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, tag, inner) => `\n\n${"#".repeat(Math.min(3, Number(String(tag)[1]) || 1))} ${oneLine(decodeEntities(String(inner).replace(/<[^>]+>/g, " ")))}\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|blockquote|tr|table|ul|ol|header|footer)\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.split("\n").map((l) => (/^\u0000PRE\d+\u0000$/.test(l.trim()) ? l.trim() : oneLine(l))).join("\n");
  s = s.replace(/\u0000PRE(\d+)\u0000/g, (_m, i) => "```\n" + (pres[Number(i)] ?? "") + "\n```");
  return { title: decodeEntities(title), text: s };
}

// JS-страницы (SPA): обычный fetch видит пустой каркас. Дочитываем headless Chromium из кэша
// Playwright (тот же браузер, что гоняет e2e): один ленивый браузер на процесс, максимум 2 страницы.
// Рантайм playwright-core грузится динамически: без браузера сервер стартует и честно отказывает только рендеру.
let renderBrowserP: Promise<Browser> | null = null;
let renderSlots = 0;
function getRenderBrowser(): Promise<Browser> {
  if (!renderBrowserP) {
    renderBrowserP = (async () => {
      const pw = await import("playwright-core");
      const b = await pw.chromium.launch({ executablePath: cfg.browserPath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      b.on("disconnected", () => { renderBrowserP = null; });
      return b;
    })();
    renderBrowserP.catch(() => { renderBrowserP = null; });
  }
  return renderBrowserP;
}
// Гард подресурсов рендера: главная страница уже прошла полную DNS-проверку assertPublicUrl,
// здесь дёшево режем явное — чужие схемы и приватные IP-литералы/локальные имена в подзапросах и редиректах.
function renderBlocked(u: URL): boolean {
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  if (cfg.webAllowPrivate) return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return isIP(host) !== 0 && isPrivateIp(host);
}
async function renderPageText(target: URL, ctx: ToolCtx): Promise<{ title: string; text: string; finalUrl: URL } | null> {
  if (!cfg.webRender) return null;
  const deadline = Date.now() + 30_000;
  while (renderSlots >= 2) {
    if (Date.now() > deadline || ctx.signal?.aborted) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  renderSlots++;
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    const browser = await getRenderBrowser();
    context = await browser.newContext({ userAgent: WEB_UA, javaScriptEnabled: true });
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      let u: URL;
      try { u = new URL(route.request().url()); } catch { void route.abort().catch(() => {}); return; }
      void (renderBlocked(u) ? route.abort().catch(() => {}) : route.continue().catch(() => {}));
    });
    await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 7_000 }).catch(() => {});
    if (ctx.signal?.aborted) return null;
    const finalUrl = new URL(page.url());
    if (renderBlocked(finalUrl)) return null;
    const html = await page.content();
    const conv = htmlToText(html, finalUrl);
    return { title: conv.title, text: conv.text, finalUrl };
  } finally {
    renderSlots--;
    await context?.close().catch(() => {});
  }
}
