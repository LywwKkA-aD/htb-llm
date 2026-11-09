# HTB: пароли, хэши, john и hashcat в контейнере

## Что чем ломать

hashcat в контейнере работает на CPU (pocl): быстрые хэши (NTLM, MD5, SHA1) — отлично; медленные (bcrypt, sha512crypt, Kerberoast при слабом пароле) — терпимо по rockyou; серьёзный крекинг вне словаря — на хосте пользователя с GPU, хэш отдать ему файлом в `/work`.

```bash
hashid -m hash.txt                       # тип хэша и режим -m, если неочевидно
hashcat -m <MODE> hash.txt /usr/share/wordlists/rockyou.txt --username  # --username, когда строки user:hash
hashcat -m <MODE> hash.txt --show        # что уже вскрыто (potfile)
john --wordlist=/usr/share/wordlists/rockyou.txt --format=<fmt> hash.txt && john --show --format=<fmt> hash.txt
```

## Режимы hashcat, которые нужны на HTB постоянно

| Что | -m |
|---|---|
| MD5 | 0 |
| SHA1 | 100 |
| SHA256 | 1400 |
| MySQL 4.1+ (sha1(sha1)) | 300 |
| phpBB/WordPress phpass $P$ | 400 |
| sha512crypt $6$ (/etc/shadow) | 1800 |
| NTLM | 1000 |
| NetNTLMv2 (Responder) | 5600 |
| Kerberoast TGS $krb5tgs$23$ | 13100 |
| AS-REP $krb5asrep$23$ | 18200 |
| bcrypt $2*$ | 3200 |
| MSSQL 2012+ | 1731 |
| PostgreSQL (md5 в pg_shadow) | 12 (с username как соль: формат hash:user разбирать по `hashcat --example-hashes`) |

Точный формат строки всегда сверять с `hashcat --example-hashes | grep -A3 "MODE: <n>"` — подмена формата ломает крекинг молча.

## Конвертеры *2john (почти каждая вторая машина)

Лежат в `/usr/share/john/`:

```bash
python3 /usr/share/john/ssh2john.py id_rsa > ssh.hash       # потом john ssh.hash
/usr/share/john/zip2john archive.zip > zip.hash
python3 /usr/share/john/office2john.py file.docx > office.hash
python3 /usr/share/john/pdf2john.py file.pdf > pdf.hash     # может называться pdf2john.pl — смотреть ls /usr/share/john/*2john*
keepass2john db.kdbx > keepass.hash
```

## Вордлисты и порядок прогонов

1. Контекстный: имя машины, компании, юзера, год/сезон — руками в маленький файл.
2. `/usr/share/seclists/Passwords/Common-Credentials/10k-most-common.txt`
3. `/usr/share/wordlists/rockyou.txt` (уже распакован)
4. Правила поверх rockyou только если есть зацепка: `hashcat -r /usr/share/hashcat/rules/best64.rule` (путь проверить `find /usr/share -name best64.rule`), на CPU для медленных хэшей это долго — предупреждать пользователя.
5. Таргетированный словарь с сайта цели: `cewl http://machine.htb -d 2 -w cewl.txt`.

По сети (hydra/medusa/nxc) ходить только пунктами 1-2 и спреем одним паролем по юзерам; rockyou по сети — почти всегда ошибка и блокировки.

```bash
hydra -l admin -P 10k.txt ssh://$TARGET -t 4 -f
nxc smb $TARGET -u users.txt -p pass.txt --continue-on-success   # сетевой перебор парами — аккуратно с политикой блокировок AD
```

## Гигиена

- Вскрытый пароль сразу пробовать на остальных сервисах и юзерах (password reuse — норма HTB), результат карточкой в память.
- Хэши без вскрытия тоже ценность: NTLM — pass-the-hash (`nxc -H`, `evil-winrm -H`, impacket с `-hashes :NTLM`).
- `--show`/potfile помнить между запусками контейнера нет: potfile по умолчанию в `~/.local/share/hashcat`, при пересоздании контейнера пропадёт — вскрытое писать в память задачи.
