# HTB: веб-энумерация и типовые атаки

## Первый проход по любому HTTP

```bash
whatweb -a 3 http://machine.htb
curl -sI http://machine.htb; curl -s http://machine.htb/robots.txt
feroxbuster -u http://machine.htb -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt -x php,txt,bak,old -o /work/ferox.txt
# виртуальные хосты (размер ответа подставить из базового запроса):
ffuf -u http://machine.htb -H "Host: FUZZ.machine.htb" -w /usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt -fs <SIZE>
```

- Найденный vhost сразу в `/etc/hosts` контейнера.
- `nikto -h http://machine.htb` — быстрый шумный проход, смотреть только конкретику (файлы, заголовки, дефолтные пути).
- Известный продукт по версии: `searchsploit <продукт> <версия>`, готовый эксплоит `searchsploit -m <id>`.

## Фаззинг параметров и контента

```bash
ffuf -u "http://machine.htb/page?id=FUZZ" -w /usr/share/seclists/Discovery/Web-Content/burp-parameter-names.txt -fs <SIZE>
ffuf -u http://machine.htb/FUZZ -w /usr/share/seclists/Discovery/Web-Content/DirBuster-2007_directory-list-2.3-medium.txt -e .php,.bak,.zip,.txt -mc 200,301,302,403
wfuzz -c -w users.txt -w pass.txt -d "user=FUZZ&pass=FUZ2Z" --hs "Invalid" http://machine.htb/login
```

403 — не конец: пробовать `/.`, `//`, `%2e`, завершающий слеш, методы и расширения; в материалах запрос `403 401 bypasses`.

## Частые классы и куда смотреть в материалах

- SQLi: вручную `'` и проверка ошибок/времени, затем `sqlmap -u "http://...?id=1" --batch --dbs` (для POST — `-r request.txt` из Burp/curl). Дамп точечно: `--tables`, `-T users --dump`.
- LFI/Path traversal: `....//....//etc/passwd`, фильтры обходятся кодировками; цель — конфиги приложения, ключи, `/proc/self/environ`. Поиск: `file inclusion`.
- Upload: расширение, MIME sniffing, `.phtml`/`.php5`, двойное расширение, magic bytes. Шеллы лежат в `/usr/share/webshells/`. Поиск: `file upload`.
- SSTI: probe `{{7*7}}`, `${7*7}`, `<%= 7*7 %>` — по ответу определять движок, дальше по материалам `ssti`.
- SSRF: цели `http://127.0.0.1:<внутренние порты>`, gopher/dict для Redis и т.п. Поиск: `ssrf`.
- JWT: `jwt_tool <token>` — alg none, слабый секрет по rockyou (`-C -d /usr/share/wordlists/rockyou.txt`), kid-инъекции.
- IDOR и логика: менять id в обе стороны, смотреть чужие объекты; API искать в JS: `curl -s .../app.js | grep -oE '/api/[^" ]+'`.

## CMS

- WordPress: `wpscan --url http://machine.htb --enumerate p,u,ap --plugins-detection aggressive` (API-токен не обязателен для базовой энумерации). Уязвимый плагин → `searchsploit wordpress <плагин>`.
- Tomcat/Jenkins/Gitea и прочее по портам 8080/8000/3000: дефолтные креды, менеджер-интерфейсы, в материалах страница `pentesting-web` по имени продукта.

## Исходники приложения после футхолда (есть шелл веб-юзером)

Половина пути user→root на веб-машинах лежит не снаружи, а в коде самого приложения — его можно читать целиком, а не угадывать снаружи:

- Конфиги и секреты: `.env`, `wp-config.php`, `config.php`, `settings.py`, `application.properties`, `*.yml` в корне приложения и на уровень выше веб-корня. Креды БД оттуда — пробовать сразу: саму БД (таблицы юзеров → хэши), SSH/su/sudo тех же юзеров, админку приложения. `grep -rInE "pass(word)?|secret|api[_-]?key|token" /var/www --include="*.php" --include="*.env" --include="*.ini" --include="*.yml" 2>/dev/null | head -50`.
- Ключи фреймворков: `APP_KEY` (Laravel), `SECRET_KEY` (Django/Flask), соли WordPress — подделка сессий/кук и сериализованных объектов. Сессии на диске (`/var/lib/php/sessions`, папка sessions приложения) читаются тем же веб-юзером.
- Кастомный код (не вендор): обработчики upload/include/eval/unserialize, самописные проверки прав, скрытые эндпоинты и debug-режимы, вызовы `exec/system/popen` с параметрами — вектор часто не в CVE, а в логике именно этого приложения.
- Связка с привеском: что из веб-корня исполняется НЕ веб-юзером — cron/systemd/incron-задачи, включающие файлы приложения, воркеры и CLI-скрипты от root/другого юзера (цепочки — в htb-05). Записываемый файл + чужой исполнитель = повышение.
- Мусор в веб-корне: `.git` (история и удалённые секреты: `git -C <path> log -p`), бэкапы `*.bak/*.zip/*.sql`, дампы БД, `phpinfo`, логи приложения с токенами, чужие шеллы и заметки в uploads.

## Работа через Burp пользователя

SOCKS из вкладки VPN вписать в Burp как upstream SOCKS proxy, браузер — в Burp. Из контейнера в Burp хоста напрямую нельзя (изоляция), поэтому запросы инструментов при необходимости повторять `curl`-ом и сверять руками, а не проксировать.

## Что фиксировать

Эндпоинты и параметры, версии CMS/плагинов, найденные креды/токены, рабочие пейлоады — карточками в память задачи; полные сканы — файлами в `/work/web/`.
