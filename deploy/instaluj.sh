#!/usr/bin/env bash
# Pierwsza instalacja DIUBI na czystym serwerze Ubuntu (Hetzner Cloud lub
# jakikolwiek VPS). Analogiczne do deploy/instaluj.sh w DiubiFix - ten sam
# wzorzec (Docker + Caddy), inny obraz aplikacji (Node.js zamiast Python).
set -euo pipefail

REPO_URL="${1:?Uzycie: instaluj.sh <url-repo-git> [katalog]}"
APP_DIR="${2:-$HOME/diubi}"

echo "== Swap (jesli serwer ma malo RAM, budowanie obrazu moze sie inaczej zawiesic) =="
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/{print $2}')" -le 2048 ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
  echo "Dodano 2GB swap."
else
  echo "Pominieto (albo juz jest, albo jest dosc RAM)."
fi

echo "== Docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "Docker juz jest zainstalowany."
fi

echo "== Klon repozytorium =="
if [ -d "$APP_DIR/.git" ]; then
  echo "Katalog $APP_DIR juz istnieje, pomijam git clone."
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "== Konfiguracja (.env) =="
  read -rp "Domena (Enter = adres tymczasowy <IP>.sslip.io): " DOMAIN_INPUT
  if [ -z "$DOMAIN_INPUT" ]; then
    SERVER_IP="$(curl -s https://api.ipify.org || echo "TWOJ-IP")"
    DOMAIN_INPUT="${SERVER_IP//./-}.sslip.io"
    echo "Uzywam tymczasowego adresu: $DOMAIN_INPUT"
  fi
  read -rsp "OPENAI_API_KEY: " OPENAI_KEY_INPUT
  echo
  cat > .env <<EOF
DOMAIN=$DOMAIN_INPUT
OPENAI_API_KEY=$OPENAI_KEY_INPUT
TARGET_LANG=pl
SOURCE_LANG=
TRANSCRIBE_MODEL=gpt-4o-transcribe
TRANSLATION_MODEL=gpt-4o-mini
MAX_USER_MINUTES_PER_DAY=30
MAX_GLOBAL_MINUTES_PER_DAY=300
AB_TEST_BATCH_TRANSCRIBE=0
EOF
  chmod 600 .env
else
  echo "Plik .env juz istnieje, pomijam konfiguracje."
fi

echo "== Budowanie i start =="
docker compose up -d --build

echo
echo "Gotowe. Adres: https://$(grep ^DOMAIN= .env | cut -d= -f2)"
echo "(Caddy potrzebuje chwili na pobranie certyfikatu HTTPS przy pierwszym uruchomieniu.)"
echo
echo "Zalecany firewall w panelu Hetznera: otwarte tylko porty 22, 80 i 443."
