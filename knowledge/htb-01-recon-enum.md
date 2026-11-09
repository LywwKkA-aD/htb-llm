# HTB: сканирование и энумерация сервисов

## Порты: быстрый проход, потом детальный

```bash
rustscan -a $TARGET --ulimit 5000 -- -Pn -oN /work/rustscan.txt
# альтернатива: nmap -p- --min-rate 2000 -Pn -oN /work/allports.txt $TARGET
nmap -sCV -p <открытые> -Pn -oN /work/nmap.txt $TARGET
nmap -sU --top-ports 30 -Pn -oN /work/nmap-udp.txt $TARGET   # UDP часто забывают: SNMP, DNS, IKE
```

- `$TARGET` — адрес машины из условия; после записи в /etc/hosts можно по имени.
- Выводы «только эти порты» делать по полному файлу скана, не по обрезанному выводу в чате.
- AutoRecon, если сервисов много: `autorecon $TARGET -o /work/recon` — сам дёрнет профильные инструменты; смотреть `/work/recon/*/report/notes.txt` и каталоги scans.

## Что делать по сервисам (первый проход)

Перед каждым сервисом ищи в материалах `pentesting <порт>` — в HackTricks есть страница почти на каждый.

- 80/443 веб: `whatweb http://$TARGET`, `curl -sI`, дальше htb-02-web. Vhost обязателен: `ffuf -H "Host: FUZZ.machine.htb"`.
- 445/139 SMB: `nxc smb $TARGET` (имя, домен, signing), `enum4linux-ng -A $TARGET`, шары без учётки: `smbclient -NL //$TARGET`, с учёткой: `smbmap -H $TARGET -u user -p pass -R`.
- 389/636/3268 LDAP: `ldapsearch -x -H ldap://$TARGET -s base namingContexts`, анонимный дамп: `ldapsearch -x -H ldap://$TARGET -b "DC=...,DC=..."`, с учёткой — `ldapdomaindump -u 'DOM\user' -p pass $TARGET`.
- 88 Kerberos + AD: см. htb-04-windows-ad (AS-REP/Kerberoasting без пароля по списку юзеров).
- 53 DNS: `dig axfr @${TARGET} machine.htb`, `dnsrecon -d machine.htb -n $TARGET -t axfr`, сабдомены по словарю `/usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt`.
- 161 SNMP: `onesixtyone -c /usr/share/seclists/Discovery/SNMP/common-snmp-community-strings-onesixtyone.txt $TARGET`, затем `snmp-check $TARGET -c <community>` или `snmpwalk -v2c -c public $TARGET`.
- 111/2049 NFS: `showmount -e $TARGET`, монтирование в контейнер может не дать (нет SYS_ADMIN) — смотреть через `nfs-ls` нет; фиксировать экспорт и думать (часто вектор через записываемую шару с SUID дома).
- 3306 MySQL / 5432 PostgreSQL / 6379 Redis / 27017 Mongo: клиенты стоят (`mysql`, `psql`, `redis-cli`). Redis без пароля: `redis-cli -h $TARGET info` — классика RCE через CONFIG SET dir/dbfilename, детали в материалах по запросу `6379 pentesting redis`.
- 5985 WinRM: при наличии кред — `evil-winrm -i $TARGET -u user -p pass` (или `-H <NTLM>`).
- 22 SSH: версии баннера, `ssh-audit` нет — `nmap -p22 --script ssh-auth-methods,ssh-hostkey $TARGET`. Брутить только с коротким таргетным списком.
- 21 FTP: anonymous, `curl -s ftp://anonymous:@$TARGET/`; 25 SMTP: `nxc smtp` нет — ручками `nc $TARGET 25` + VRFY/EXPN по списку имён.
- TLS где угодно: `sslscan $TARGET:<port>` — в сертификате часто торчат vhosts (SAN).

## Юзернеймы и пароли на старте

- Имена: с сайта (авторы, about), из LDAP/SMB RID-brute (`nxc smb $TARGET --rid-brute`), Kerberos userenum: `kerbrute userenum --dc $TARGET -d domain.local /usr/share/seclists/Usernames/top-usernames-shortlist.txt`.
- Первый парольный проход: имя машины/компании/сезон+год, затем `/usr/share/seclists/Passwords/Common-Credentials/10k-most-common.txt`. Rockyou — когда есть хэш оффлайн, не по сети.
- Любой найденный пароль пробовать везде: SSH, SMB, WinRM, веб-логин, БД. Фиксировать карточкой, где работает.

## Организация вывода

Сканы и энумерацию складывать в `/work` по шагам: `nmap.txt`, `web/`, `smb/` и т.п. Итоговый ответ пользователю — только суть: открытые сервисы, версии, вероятные векторы по приоритету.
