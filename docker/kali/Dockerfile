# whitehat-agent: песочница на одну задачу (Kali rolling + сетевые/Linux инструменты + топ тулов для HTB)
# Пересборка долгая (~5 ГБ установленного): bin/whitehat сам пересоберёт образ, когда этот файл новее образа.
FROM kalilinux/kali-rolling
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# В docker-образах man-страницы обычно вырезаны — возвращаем, агенту и тебе они нужны.
RUN rm -f /etc/dpkg/dpkg.cfg.d/excludes /etc/dpkg/dpkg.cfg.d/docker* 2>/dev/null; \
    apt-get update && apt-get install -y --no-install-recommends \
      iproute2 iputils-ping iputils-tracepath traceroute mtr-tiny net-tools ethtool bridge-utils \
      iptables nftables arping arp-scan tcpdump tshark nmap hping3 netcat-openbsd socat ncat \
      dnsutils whois curl wget openssl ca-certificates openssh-client telnet lftp iperf3 \
      snmp ldap-utils smbclient samba-common-bin nfs-common redis-tools default-mysql-client postgresql-client \
      nikto gobuster sqlmap hydra medusa whatweb \
      python3 python3-scapy python3-requests python3-pip pipx \
      man-db manpages vim nano less tree jq file procps psmisc lsof strace htop bash-completion git sudo \
      openvpn wireguard-tools microsocks proxychains4 tmux rlwrap rsync \
      rustscan masscan autorecon dnsenum dnsrecon nbtscan onesixtyone snmpcheck enum4linux-ng smbmap sslscan subfinder httpx-toolkit \
      ffuf feroxbuster dirsearch wfuzz wpscan commix webshells nuclei \
      impacket-scripts netexec evil-winrm responder bloodhound.py python3-ldapdomaindump certipy-ad coercer krb5-user libfaketime mimikatz powersploit \
      john hashcat hashid hashcat-utils cewl crunch wordlists seclists \
      metasploit-framework exploitdb build-essential gdb \
      xxd 7zip unzip dos2unix sqlite3 ripgrep libimage-exiftool-perl binwalk steghide \
    && rm -rf /var/lib/apt/lists/* && (mandb -q || true)
# rockyou нужен распакованным: john/hashcat в разгар машины ждать gunzip не должны.
RUN test -f /usr/share/wordlists/rockyou.txt.gz && gzip -dc /usr/share/wordlists/rockyou.txt.gz > /usr/share/wordlists/rockyou.txt
# Не-apt инструменты (свежие релизы с GitHub). На раздачу целям: /opt/tools/linux и /opt/tools/windows;
# то, что запускается у нас, — в /usr/local/bin. Все загрузки через curl -f: битая ссылка валит сборку, а не образ.
ARG CHISEL_VER=1.10.1
ARG LIGOLO_VER=0.8.2
ARG PSPY_VER=1.2.1
RUN mkdir -p /opt/tools/linux /opt/tools/windows && \
    curl -fsSL --retry 3 -o /opt/tools/linux/linpeas.sh https://github.com/peass-ng/PEASS-ng/releases/latest/download/linpeas.sh && \
    curl -fsSL --retry 3 -o /opt/tools/windows/winPEASx64.exe https://github.com/peass-ng/PEASS-ng/releases/latest/download/winPEASx64.exe && \
    curl -fsSL --retry 3 -o /opt/tools/windows/winPEAS.bat https://github.com/peass-ng/PEASS-ng/releases/latest/download/winPEAS.bat && \
    curl -fsSL --retry 3 -o /opt/tools/linux/pspy64 https://github.com/DominicBreuker/pspy/releases/download/v${PSPY_VER}/pspy64 && \
    curl -fsSL --retry 3 -o /opt/tools/linux/pspy32 https://github.com/DominicBreuker/pspy/releases/download/v${PSPY_VER}/pspy32 && \
    curl -fsSL --retry 3 -o /opt/tools/linux/LinEnum.sh https://raw.githubusercontent.com/rebootuser/LinEnum/master/LinEnum.sh && \
    curl -fsSL --retry 3 -o /opt/tools/linux/linux-exploit-suggester.sh https://raw.githubusercontent.com/The-Z-Labs/linux-exploit-suggester/master/linux-exploit-suggester.sh && \
    curl -fsSL --retry 3 -o /usr/local/bin/kerbrute https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64 && \
    curl -fsSL --retry 3 https://github.com/jpillora/chisel/releases/download/v${CHISEL_VER}/chisel_${CHISEL_VER}_linux_amd64.gz | gunzip > /usr/local/bin/chisel && \
    curl -fsSL --retry 3 https://github.com/jpillora/chisel/releases/download/v${CHISEL_VER}/chisel_${CHISEL_VER}_windows_amd64.gz | gunzip > /opt/tools/windows/chisel.exe && \
    curl -fsSL --retry 3 -o /usr/local/bin/penelope https://raw.githubusercontent.com/brightio/penelope/master/penelope.py && \
    chmod +x /opt/tools/linux/* /usr/local/bin/kerbrute /usr/local/bin/chisel /usr/local/bin/penelope
# ligolo-ng согласованной парой одного релиза (apt-версия proxy новее релизных агентов — протокол может разойтись)
RUN mkdir -p /tmp/ligolo && cd /tmp/ligolo && \
    curl -fsSL --retry 3 -o proxy.tar.gz https://github.com/nicocha30/ligolo-ng/releases/download/v${LIGOLO_VER}/ligolo-ng_proxy_${LIGOLO_VER}_linux_amd64.tar.gz && \
    tar -xzf proxy.tar.gz && install -m755 "$(find . -type f -name '*proxy*' | head -1)" /usr/local/bin/ligolo-proxy && \
    curl -fsSL --retry 3 -o agent.tar.gz https://github.com/nicocha30/ligolo-ng/releases/download/v${LIGOLO_VER}/ligolo-ng_agent_${LIGOLO_VER}_linux_amd64.tar.gz && \
    tar -xzf agent.tar.gz && install -m755 "$(find . -type f -name '*agent*' | head -1)" /opt/tools/linux/ligolo-agent && \
    curl -fsSL --retry 3 -o agent-win.zip https://github.com/nicocha30/ligolo-ng/releases/download/v${LIGOLO_VER}/ligolo-ng_agent_${LIGOLO_VER}_windows_amd64.zip && \
    unzip -o agent-win.zip -d win >/dev/null && install -m644 "$(find win -type f -name '*.exe' | head -1)" /opt/tools/windows/ligolo-agent.exe && \
    cd / && rm -rf /tmp/ligolo && ligolo-proxy -h >/dev/null 2>&1 || true; test -x /usr/local/bin/ligolo-proxy
# jwt_tool из исходников (pip-зависимости мелкие)
RUN git clone --depth 1 https://github.com/ticarpi/jwt_tool /opt/tools/jwt_tool && \
    python3 -m pip install --break-system-packages -q -r /opt/tools/jwt_tool/requirements.txt && \
    printf '#!/bin/sh\nexec python3 /opt/tools/jwt_tool/jwt_tool.py "$@"\n' > /usr/local/bin/jwt_tool && chmod +x /usr/local/bin/jwt_tool
# Python-библиотеки для тайминг/SSH-скриптов (модель ставила numpy через apt прямо в ходе — после reset пропадал).
# Отдельным слоем в конце: пересборка при добавлении пакетов не сносит кэш большого apt-слоя выше.
RUN apt-get update && apt-get install -y --no-install-recommends python3-numpy python3-paramiko \
    && rm -rf /var/lib/apt/lists/* && python3 -c "import numpy, paramiko; print('numpy+paramiko ok')"
# Java: в базовом слое только JRE 25 (приходит с зависимостями) — javac нет, а JNDI-тулам и старым целям нужна Java 8.
# Ставим default-jdk (обычный javac) + Temurin JDK 8 в /opt/jdk8 (java8/javac8/jar8) и собираем под ним
# rogue-jndi + marshalsec; welk1n JNDI-Injection-Exploit — готовый jar. Wrappers сами запускают java8.
ARG TEMURIN8_VER=jdk8u512-b09
ARG TEMURIN8_FILE=OpenJDK8U-jdk_x64_linux_hotspot_8u512b09.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends default-jdk-headless maven \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/jdk8 /opt/tools/jndi \
    && curl -fsSL --retry 3 https://github.com/adoptium/temurin8-binaries/releases/download/${TEMURIN8_VER}/${TEMURIN8_FILE} | tar -xz -C /opt/jdk8 --strip-components=1 \
    && ln -sf /opt/jdk8/bin/java /usr/local/bin/java8 \
    && ln -sf /opt/jdk8/bin/javac /usr/local/bin/javac8 \
    && ln -sf /opt/jdk8/bin/jar /usr/local/bin/jar8 \
    && export JAVA_HOME=/opt/jdk8 PATH="/opt/jdk8/bin:$PATH" \
    && git clone --depth 1 -q https://github.com/veracode-research/rogue-jndi /tmp/rogue-jndi \
    && git clone --depth 1 -q https://github.com/mbechler/marshalsec /tmp/marshalsec \
    && (cd /tmp/rogue-jndi && mvn -B -DskipTests package && cp target/RogueJndi-*.jar /opt/tools/jndi/rogue-jndi.jar) \
    && (cd /tmp/marshalsec && mvn -B -DskipTests package && cp target/marshalsec-*-all.jar /opt/tools/jndi/marshalsec.jar) \
    && curl -fsSL --retry 3 -o /opt/tools/jndi/JNDI-Injection-Exploit.jar https://github.com/welk1n/JNDI-Injection-Exploit/releases/download/v1.0/JNDI-Injection-Exploit-1.0-SNAPSHOT-all.jar \
    && printf '#!/bin/sh\nexec /opt/jdk8/bin/java -jar /opt/tools/jndi/rogue-jndi.jar "$@"\n' > /usr/local/bin/rogue-jndi \
    && printf '#!/bin/sh\nexec /opt/jdk8/bin/java -cp /opt/tools/jndi/marshalsec.jar marshalsec.jndi.LDAPRefServer "$@"\n' > /usr/local/bin/ldaprefserver \
    && printf '#!/bin/sh\nexec /opt/jdk8/bin/java -jar /opt/tools/jndi/JNDI-Injection-Exploit.jar "$@"\n' > /usr/local/bin/jndi-injection-exploit \
    && chmod +x /usr/local/bin/rogue-jndi /usr/local/bin/ldaprefserver /usr/local/bin/jndi-injection-exploit \
    && rm -rf /tmp/rogue-jndi /tmp/marshalsec /root/.m2 \
    && javac -version && javac8 -version && test -s /opt/tools/jndi/rogue-jndi.jar && test -s /opt/tools/jndi/marshalsec.jar && test -s /opt/tools/jndi/JNDI-Injection-Exploit.jar
# Точечные дыры основного арсенала (п.17 плана): bloodyAD — запись прав в AD через LDAP (pipx-изоляция:
# его пины cryptography/asn1crypto не должны трогать системные библиотеки impacket) и katana — краулер
# ProjectDiscovery (релизный бинарь, как kerbrute/chisel выше).
ARG BLOODYAD_VER=2.5.7
ARG KATANA_VER=1.8.0
RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install "bloodyAD==${BLOODYAD_VER}" \
    && bloodyAD --help >/dev/null
RUN mkdir -p /tmp/katana && cd /tmp/katana && \
    curl -fsSL --retry 3 -o katana.zip https://github.com/projectdiscovery/katana/releases/download/v${KATANA_VER}/katana_${KATANA_VER}_linux_amd64.zip && \
    unzip -o katana.zip >/dev/null && install -m755 katana /usr/local/bin/katana && \
    cd / && rm -rf /tmp/katana && katana -version
# История команд пишется в /work сразу после каждой команды — агент видит, что ты делал в терминале.
# Kali в .bashrc ставит PROMPT_COMMAND="PROMPT_COMMAND=echo" (перезаписывает сам себя на первом приглашении),
# поэтому задаём PROMPT_COMMAND целиком, а не дописываем. .hushlogin — без баннера Kali при каждом входе.
RUN printf '%s\n' \
  'export HISTFILE=/work/.bash_history HISTSIZE=10000 HISTFILESIZE=20000 HISTTIMEFORMAT="%F %T "' \
  'shopt -s histappend' \
  'PROMPT_COMMAND="history -a"' \
  'export PIP_BREAK_SYSTEM_PACKAGES=1' \
  'export PS1="\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;32m\]\w\[\e[0m\]\$ "' \
  >> /root/.bashrc && touch /root/.hushlogin
WORKDIR /work
CMD ["sleep", "infinity"]
