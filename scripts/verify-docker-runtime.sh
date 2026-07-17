#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repository_root
readonly app_port="${VERIFY_DOCKER_PORT:-38123}"
readonly project_name="ha-digest-verify-$$"
readonly admin_token="docker-runtime-verification-admin-token"
readonly setup_token="docker-runtime-verification-setup-token"

temp_dir=''
ha_log_file=''
cleanup_complete=false

usage() {
  cat <<'EOF'
Usage: pnpm verify:docker

Builds and smoke-tests the Docker runtime in local and reverse-proxy modes.
It creates an isolated temporary Compose project and removes its containers,
volume, and files on exit. The command does not print supplied tokens.
EOF
}

if [[ "${1:-}" == '--help' ]]; then
  usage
  exit 0
fi

redact_file() {
  local path="$1"
  sed \
    -e "s/${admin_token}/[REDACTED]/g" \
    -e "s/${setup_token}/[REDACTED]/g" \
    "$path"
}

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ "$cleanup_complete" == false ]]; then
    compose_proxy down --volumes --remove-orphans >/dev/null 2>&1 || true
    cleanup_complete=true

    if [[ -n "$temp_dir" ]]; then
      case "$temp_dir" in
        "${TMPDIR:-/tmp}"/ha-digest-verify.*) rm -rf -- "$temp_dir" ;;
        *) printf 'Refusing to remove an unexpected temporary path.\n' >&2 ;;
      esac
    fi
  fi

  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

compose_environment() {
  env \
    ADMIN_TOKEN="$admin_token" \
    SETUP_TOKEN="$setup_token" \
    APP_BIND_ADDRESS=127.0.0.1 \
    APP_PORT="$app_port" \
    HA_LOG_FILE="$ha_log_file" \
    docker compose --project-name "$project_name" -f "$repository_root/compose.yaml" "$@"
}

compose_proxy() {
  env \
    ADMIN_TOKEN="$admin_token" \
    SETUP_TOKEN="$setup_token" \
    APP_BIND_ADDRESS=127.0.0.1 \
    APP_PORT="$app_port" \
    HA_LOG_FILE="$ha_log_file" \
    docker compose --project-name "$project_name" -f "$repository_root/compose.yaml" -f "$repository_root/compose.reverse-proxy.yaml" "$@"
}

run_quietly() {
  local log_file="$temp_dir/command.log"
  if ! "$@" >"$log_file" 2>&1; then
    printf 'Docker verification command failed; redacted diagnostics follow:\n' >&2
    redact_file "$log_file" >&2 || true
    return 1
  fi
}

wait_for_http_status() {
  local expected_status="$1"
  local attempts="${2:-30}"
  local response_file="$temp_dir/http-response"
  local status='000'

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    status="$(curl --silent --output "$response_file" --write-out '%{http_code}' "http://127.0.0.1:${app_port}/ready" || true)"
    if [[ "$status" == "$expected_status" ]]; then
      return 0
    fi
    sleep 1
  done

  printf 'Expected /ready to return HTTP %s but last response was HTTP %s.\n' "$expected_status" "$status" >&2
  return 1
}

wait_for_health_status() {
  local expected_status="$1"
  local attempts="${2:-60}"
  local container_id=''
  local status='unknown'

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    container_id="$(compose_environment ps --quiet app)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
      if [[ "$status" == "$expected_status" ]]; then
        return 0
      fi
    fi
    sleep 2
  done

  printf 'Expected Docker health status %s but last status was %s.\n' "$expected_status" "$status" >&2
  return 1
}

assert_local_cookie_contract() {
  local headers_file="$temp_dir/local-headers"

  curl --silent --show-error --output /dev/null --dump-header "$headers_file" \
    --header 'Content-Type: application/json' \
    --header 'X-Forwarded-Proto: https' \
    --data "{\"adminToken\":\"${admin_token}\"}" \
    "http://127.0.0.1:${app_port}/api/session"

  if grep -qi '^set-cookie:.*; Secure' "$headers_file"; then
    printf 'Local mode unexpectedly emitted a Secure cookie.\n' >&2
    return 1
  fi
}

assert_reverse_proxy_cookie_contract() {
  local headers_file="$temp_dir/reverse-proxy-headers"

  curl --silent --show-error --output /dev/null --dump-header "$headers_file" \
    --header 'Content-Type: application/json' \
    --header 'X-Forwarded-Proto: https' \
    --data "{\"adminToken\":\"${admin_token}\"}" \
    "http://127.0.0.1:${app_port}/api/session"

  if ! grep -qi '^set-cookie:.*; Secure' "$headers_file"; then
    printf 'Reverse-proxy mode did not emit a Secure cookie for a forwarded HTTPS request.\n' >&2
    return 1
  fi
}

assert_write_boundaries() {
  run_quietly compose_environment exec -T app sh -eu -c '
    if touch /app/docker-runtime-verification-write 2>/dev/null; then
      printf "Unexpectedly wrote to /app.\n" >&2
      exit 1
    fi
    touch /tmp/docker-runtime-verification-write
    touch /data/docker-runtime-verification-write
    test -f /tmp/docker-runtime-verification-write
    test -f /data/docker-runtime-verification-write
  '
}

assert_restart_persistence() {
  run_quietly compose_environment exec -T app sh -eu -c '
    test -s /data/app.db
    test -s /data/app.key
    printf persistent > /data/docker-runtime-verification-persistence
  '
  run_quietly compose_environment restart app
  wait_for_http_status 200
  # shellcheck disable=SC2016 # Command substitution must occur in the container.
  run_quietly compose_environment exec -T app sh -eu -c '
    test "$(cat /data/docker-runtime-verification-persistence)" = persistent
    test -s /data/app.db
    test -s /data/app.key
  '
}

assert_unreadable_log_becomes_unhealthy() {
  chmod 000 "$ha_log_file"
  run_quietly compose_environment restart app
  wait_for_http_status 503
  wait_for_health_status unhealthy 65
  chmod 0644 "$ha_log_file"
}

require_dependencies() {
  command -v docker >/dev/null
  command -v curl >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
}

main() {
  require_dependencies
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/ha-digest-verify.XXXXXX")"
  ha_log_file="$temp_dir/home-assistant.log"
  printf 'Docker runtime verification fixture\n' >"$ha_log_file"
  chmod 0644 "$ha_log_file"

  printf 'Validating local Docker runtime mode.\n'
  run_quietly compose_environment config --quiet
  run_quietly compose_environment up --build --detach
  wait_for_http_status 200
  assert_local_cookie_contract
  assert_write_boundaries
  assert_restart_persistence
  assert_unreadable_log_becomes_unhealthy
  run_quietly compose_environment down --volumes --remove-orphans

  printf 'Validating reverse-proxy Docker runtime mode.\n'
  run_quietly compose_proxy config --quiet
  run_quietly compose_proxy up --build --detach
  wait_for_http_status 200
  assert_reverse_proxy_cookie_contract

  printf 'Docker runtime verification passed.\n'
}

main "$@"
