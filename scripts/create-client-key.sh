#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${GATEWAY_ENV_FILE:-${PROJECT_DIR}/.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  printf 'Environment file not found: %s\nCopy .env.example to .env and configure it first.\n' "${ENV_FILE}" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo 'openssl is required to generate a random client key.' >&2
  exit 1
fi

umask 077
client_key="$(openssl rand -hex 32)"
tmp_file="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "${tmp_file}"' EXIT

awk -v key="${client_key}" '
  /^CLIENT_API_KEYS=/ {
    current = substr($0, index($0, "=") + 1)
    if (current != "") current = current ","
    print "CLIENT_API_KEYS=" current key
    found = 1
    next
  }
  { print }
  END {
    if (!found) print "CLIENT_API_KEYS=" key
  }
' "${ENV_FILE}" > "${tmp_file}"
chmod 600 "${tmp_file}"
mv "${tmp_file}" "${ENV_FILE}"
trap - EXIT
chmod 600 "${ENV_FILE}"

printf 'New client API key (copy it now; it is stored in %s):\n%s\n' "${ENV_FILE}" "${client_key}"
printf '\nAfter adding the key, apply it to the running gateway with:\n  docker compose up -d --force-recreate gateway\n'
