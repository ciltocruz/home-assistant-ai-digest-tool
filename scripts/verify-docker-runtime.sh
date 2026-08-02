#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repository_root

readonly verifier_duration_seconds="${VERIFY_DOCKER_DURATION_SECONDS:-180}"
readonly cleanup_grace_seconds="${VERIFY_DOCKER_CLEANUP_GRACE_SECONDS:-20}"
readonly caller_cushion_seconds="${VERIFY_DOCKER_CALLER_CUSHION_SECONDS:-5}"

print_timeout_contract() {
  node --input-type=module -e '
    const durationSeconds = Number(process.argv[1]);
    const cleanupGraceSeconds = Number(process.argv[2]);
    const callerCushionSeconds = Number(process.argv[3]);
    process.stdout.write(`${JSON.stringify({
      durationSeconds,
      cleanupGraceSeconds,
      callerTimeoutSeconds: durationSeconds + cleanupGraceSeconds + callerCushionSeconds
    })}\n`);
  ' "$verifier_duration_seconds" "$cleanup_grace_seconds" "$caller_cushion_seconds"
}

app_port=''
project_name=''
readonly admin_token="docker-runtime-verification-admin-token"
readonly setup_token="docker-runtime-verification-setup-token"
readonly ha_token="docker-runtime-verification-ha-token"

temp_dir=''
ha_log_file=''
cleanup_complete=false
compose_started=false
port_holder_pid=''
deadline_started_at=0
last_http_status='not-observed'
last_health_status='not-observed'
readonly run_root="${VERIFY_DOCKER_RUN_ROOT:-${TMPDIR:-/tmp}/ha-digest-verify-runs}"

validate_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

require_timeout_contract() {
  validate_positive_integer "$verifier_duration_seconds" || {
    printf 'VERIFY_DOCKER_DURATION_SECONDS must be a positive integer.\n' >&2
    return 1
  }
  validate_positive_integer "$cleanup_grace_seconds" || {
    printf 'VERIFY_DOCKER_CLEANUP_GRACE_SECONDS must be a positive integer.\n' >&2
    return 1
  }
  validate_positive_integer "$caller_cushion_seconds" || {
    printf 'VERIFY_DOCKER_CALLER_CUSHION_SECONDS must be a positive integer.\n' >&2
    return 1
  }
}

release_port_reservation() {
  if [[ -n "$port_holder_pid" ]]; then
    kill "$port_holder_pid" >/dev/null 2>&1 || true
    wait "$port_holder_pid" >/dev/null 2>&1 || true
    port_holder_pid=''
  fi
}

reserve_port() {
  local requested_port="$1"
  local ready_file="$temp_dir/port-reservation"
  local error_file="$temp_dir/port-reservation-error"
  local started_at="$SECONDS"

  rm -f -- "$ready_file" "$error_file"
  node --input-type=module - "$requested_port" "$ready_file" "$error_file" <<'NODE' >/dev/null 2>&1 &
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const [port, readyFile, errorFile] = process.argv.slice(2);
const server = createServer();
server.once('error', (error) => {
  writeFileSync(errorFile, error.code ?? 'unknown');
  process.exit(1);
});
server.listen(Number(port), '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') process.exit(1);
  writeFileSync(readyFile, String(address.port));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
setInterval(() => {}, 1_000);
NODE
  port_holder_pid="$!"

  while (( SECONDS - started_at < 5 )); do
    if [[ -s "$ready_file" ]]; then
      app_port="$(<"$ready_file")"
      return 0
    fi
    if [[ -s "$error_file" ]]; then
      release_port_reservation
      return 1
    fi
    sleep 0.05
  done

  release_port_reservation
  printf 'Timed out while reserving verification port %s.\n' "$requested_port" >&2
  return 1
}

reserve_verification_port() {
  if [[ -n "${VERIFY_DOCKER_PORT:-}" ]]; then
    if ! reserve_port "$VERIFY_DOCKER_PORT"; then
      printf 'Requested verification port %s is unavailable; stop its owner or choose another VERIFY_DOCKER_PORT.\n' "$VERIFY_DOCKER_PORT" >&2
      return 1
    fi
    return 0
  fi

  reserve_port 38123 || reserve_port 0
}

process_start_token() {
  local pid="$1"
  if [[ -r "/proc/${pid}/stat" ]]; then
    awk '{ print $22 }' "/proc/${pid}/stat"
  else
    ps -o lstart= -p "$pid" 2>/dev/null | tr -d ' '
  fi
}

write_run_metadata() {
  local start_token
  start_token="$(process_start_token "$$")"
  cat >"$temp_dir/metadata" <<EOF
owner_pid=$$
owner_start_token=$start_token
project_name=$project_name
port=$app_port
created_at=$(date +%s)
EOF
  chmod 0600 "$temp_dir/metadata"
}

create_run_workspace() {
  mkdir -p -- "$run_root"
  chmod 0700 "$run_root"
  temp_dir="$(mktemp -d "$run_root/run.XXXXXX")"
  project_name="ha-digest-verify-$(basename "$temp_dir" | tr '[:upper:].' '[:lower:]_')"
  ha_log_file="$temp_dir/home-assistant.log"
}

remaining_deadline_seconds() {
  local elapsed=$(( SECONDS - deadline_started_at ))
  local remaining=$(( verifier_duration_seconds - elapsed ))
  (( remaining > 0 )) || return 1
  printf '%s\n' "$remaining"
}

report_deadline_failure() {
  local phase="$1"
  local elapsed=$(( SECONDS - deadline_started_at ))
  printf 'Verifier deadline exhausted: phase=%s elapsed_seconds=%s last_http_status=%s last_health_status=%s.\n' \
    "$phase" "$elapsed" "$last_http_status" "$last_health_status" >&2
}

sleep_with_deadline() {
  local remaining
  remaining="$(remaining_deadline_seconds)" || return 1
  if (( remaining > 1 )); then
    sleep 1
  else
    sleep 0.1
  fi
}

usage() {
  cat <<'EOF'
Usage: pnpm verify:docker

Builds and smoke-tests the Docker runtime in local and reverse-proxy modes.
It creates an isolated temporary Compose project and removes its containers,
volume, and files on exit. The command does not print supplied tokens.

Options:
  --preflight               Reserve and validate a verification port without Docker.
  --print-timeout-contract  Print the verifier and caller timeout contract as JSON.
EOF
}

if [[ "${1:-}" == '--help' ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == '--print-timeout-contract' ]]; then
  print_timeout_contract
  exit 0
fi

redact_file() {
  local path="$1"
  sed \
    -e "s/${admin_token}/[REDACTED]/g" \
    -e "s/${setup_token}/[REDACTED]/g" \
    -e "s/${ha_token}/[REDACTED]/g" \
    -e 's/\([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]: [Bb][Ee][Aa][Rr][Ee][Rr] \)[^[:space:]]*/\1[REDACTED]/g' \
    -e 's/\([Cc][Ss][Rr][Ff][Tt][Oo][Kk][Ee][Nn]\)[=:][^[:space:]]*/\1=[REDACTED]/g' \
    -e 's/\([Xx]-[Cc][Ss][Rr][Ff]-[Tt][Oo][Kk][Ee][Nn]\)[=:][^[:space:]]*/\1=[REDACTED]/g' \
    -e 's/\(ha_digest_session\)[=:][^[:space:]]*/\1=[REDACTED]/g' \
    "$path"
}

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ "$cleanup_complete" == false ]]; then
    release_port_reservation
    if [[ "$compose_started" == true ]]; then
      compose_environment down --volumes --remove-orphans >/dev/null 2>&1 || true
      compose_proxy down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
    cleanup_complete=true

    if [[ -n "$temp_dir" ]]; then
      case "$temp_dir" in
        "$run_root"/run.*) rm -rf -- "$temp_dir" ;;
        *) printf 'Refusing to remove an unexpected temporary path.\n' >&2 ;;
      esac
    fi
  fi

  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose_environment() {
  env \
    ADMIN_TOKEN="$admin_token" \
    SETUP_TOKEN="$setup_token" \
    APP_BIND_ADDRESS=127.0.0.1 \
    APP_PORT="$app_port" \
    HA_LOG_FILE="$ha_log_file" \
    docker compose --project-name "$project_name" -f "$repository_root/compose.yaml" -f "$repository_root/compose.verify.yaml" "$@"
}

compose_environment_with_deadline() {
  local remaining="$1"
  shift
  env \
    ADMIN_TOKEN="$admin_token" \
    SETUP_TOKEN="$setup_token" \
    APP_BIND_ADDRESS=127.0.0.1 \
    APP_PORT="$app_port" \
    HA_LOG_FILE="$ha_log_file" \
    timeout --foreground "${remaining}s" docker compose --project-name "$project_name" -f "$repository_root/compose.yaml" -f "$repository_root/compose.verify.yaml" "$@"
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

compose_proxy_with_deadline() {
  local remaining="$1"
  shift
  env \
    ADMIN_TOKEN="$admin_token" \
    SETUP_TOKEN="$setup_token" \
    APP_BIND_ADDRESS=127.0.0.1 \
    APP_PORT="$app_port" \
    HA_LOG_FILE="$ha_log_file" \
    timeout --foreground "${remaining}s" docker compose --project-name "$project_name" -f "$repository_root/compose.yaml" -f "$repository_root/compose.reverse-proxy.yaml" "$@"
}

remove_project_resources() {
  local project="$1"
  local project_port="${2:-$app_port}"
  env \
    ADMIN_TOKEN="$admin_token" \
    SETUP_TOKEN="$setup_token" \
    APP_BIND_ADDRESS=127.0.0.1 \
    APP_PORT="$project_port" \
    HA_LOG_FILE="$ha_log_file" \
    docker compose --project-name "$project" -f "$repository_root/compose.yaml" -f "$repository_root/compose.verify.yaml" down --volumes --remove-orphans
}

metadata_value() {
  local metadata_path="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { count++; value = substr($0, length(key) + 2) } END { if (count == 1) print value; else exit 1 }' "$metadata_path"
}

metadata_owner_is_active() {
  local pid="$1"
  local start_token="$2"
  kill -0 "$pid" >/dev/null 2>&1 && [[ "$(process_start_token "$pid" 2>/dev/null || true)" == "$start_token" ]]
}

recover_stale_verification_runs() {
  local metadata_path workspace owner_pid owner_start_token stale_project stale_port created_at now

  for metadata_path in "$run_root"/run.*/metadata; do
    [[ -f "$metadata_path" ]] || continue
    workspace="$(dirname "$metadata_path")"
    owner_pid="$(metadata_value "$metadata_path" owner_pid 2>/dev/null || true)"
    owner_start_token="$(metadata_value "$metadata_path" owner_start_token 2>/dev/null || true)"
    stale_project="$(metadata_value "$metadata_path" project_name 2>/dev/null || true)"
    stale_port="$(metadata_value "$metadata_path" port 2>/dev/null || true)"
    created_at="$(metadata_value "$metadata_path" created_at 2>/dev/null || true)"

    if [[ ! "$owner_pid" =~ ^[1-9][0-9]*$ ]] ||
      [[ ! "$owner_start_token" =~ ^[A-Za-z0-9._-]+$ ]] ||
      [[ ! "$stale_project" =~ ^ha-digest-verify-[A-Za-z0-9._-]+$ ]] ||
      [[ ! "$stale_port" =~ ^[1-9][0-9]{0,4}$ ]] ||
      [[ ! "$created_at" =~ ^[1-9][0-9]*$ ]]; then
      printf 'Skipping malformed verifier recovery record: %s\n' "$metadata_path" >&2
      continue
    fi

    now="$(date +%s)"
    if (( now - created_at < cleanup_grace_seconds )) || metadata_owner_is_active "$owner_pid" "$owner_start_token"; then
      continue
    fi

    if remove_project_resources "$stale_project" "$stale_port" >/dev/null 2>&1; then
      rm -rf -- "$workspace"
    fi
  done
}

run_quietly() {
  local log_file="$temp_dir/command.log"
  local remaining
  remaining="$(remaining_deadline_seconds)" || {
    report_deadline_failure command
    return 1
  }

  if ! case "$1" in
    compose_environment)
      shift
      compose_environment_with_deadline "$remaining" "$@"
      ;;
    compose_proxy)
      shift
      compose_proxy_with_deadline "$remaining" "$@"
      ;;
    *)
      timeout --foreground "${remaining}s" "$@"
      ;;
  esac >"$log_file" 2>&1; then
    printf 'Docker verification command failed; redacted diagnostics follow:\n' >&2
    redact_file "$log_file" >&2 || true
    return 1
  fi
}

wait_for_http_status() {
  local expected_status="$1"
  local response_file="$temp_dir/http-response"
  local remaining

  while remaining="$(remaining_deadline_seconds)"; do
    last_http_status="$(curl --max-time "$remaining" --silent --output "$response_file" --write-out '%{http_code}' "http://127.0.0.1:${app_port}/ready" || true)"
    if [[ "$last_http_status" == "$expected_status" ]]; then
      return 0
    fi
    sleep_with_deadline || break
  done

  report_deadline_failure readiness
  printf 'Expected /ready to return HTTP %s but last response was HTTP %s.\n' "$expected_status" "$last_http_status" >&2
  return 1
}

wait_for_health_status() {
  local expected_status="$1"
  local container_id=''
  local remaining

  while remaining="$(remaining_deadline_seconds)"; do
    container_id="$(compose_environment_with_deadline "$remaining" ps --quiet app 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      last_health_status="$(timeout --foreground "${remaining}s" docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$last_health_status" == "$expected_status" ]]; then
        return 0
      fi
    fi
    sleep_with_deadline || break
  done

  report_deadline_failure health
  printf 'Expected Docker health status %s but last status was %s.\n' "$expected_status" "$last_health_status" >&2
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

json_field() {
  local file="$1"
  local path="$2"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const result = process.argv[2].split(".").reduce((current, key) => current?.[key], value);
    if (typeof result !== "string") process.exit(1);
    process.stdout.write(result);
  ' "$file" "$path"
}

complete_persisted_onboarding() {
  local setup_file="$temp_dir/onboarding-complete.json"
  local cookie_file="$temp_dir/session.cookie"
  curl --fail --silent --show-error \
    --request PATCH \
    --header "Authorization: Bearer ${setup_token}" \
    --header 'Content-Type: application/json' \
    --data "{\"step\":\"home_assistant\",\"draft\":{\"haUrl\":\"http://fake-ha:8123\"},\"secrets\":{\"haToken\":\"${ha_token}\"}}" \
    "http://127.0.0.1:${app_port}/api/onboarding" >/dev/null
  curl --fail --silent --show-error \
    --request PATCH \
    --header "Authorization: Bearer ${setup_token}" \
    --header 'Content-Type: application/json' \
    --data '{"step":"ai_provider","draft":{"aiProvider":"gemini"},"secrets":{"aiKey":"fixture-ai-key"}}' \
    "http://127.0.0.1:${app_port}/api/onboarding" >/dev/null
  curl --fail --silent --show-error \
    --request PATCH \
    --header "Authorization: Bearer ${setup_token}" \
    --header 'Content-Type: application/json' \
    --data '{"step":"notifications","draft":{"notifier":"markdown"},"secrets":{}}' \
    "http://127.0.0.1:${app_port}/api/onboarding" >/dev/null
  curl --fail --silent --show-error \
    --request PATCH \
    --header "Authorization: Bearer ${setup_token}" \
    --header 'Content-Type: application/json' \
    --data '{"step":"schedule","draft":{"dailyTime":"08:00","timezone":"Europe/Madrid"},"secrets":{}}' \
    "http://127.0.0.1:${app_port}/api/onboarding" >/dev/null
  curl --fail --silent --show-error \
    --request PATCH \
    --header "Authorization: Bearer ${setup_token}" \
    --header 'Content-Type: application/json' \
    --data '{"step":"privacy","draft":{"privacyLevel":"balanced","retentionDays":90,"privacyAccepted":true},"secrets":{}}' \
    "http://127.0.0.1:${app_port}/api/onboarding" >/dev/null
  curl --fail --silent --show-error --cookie-jar "$cookie_file" --output "$setup_file" \
    --header "Authorization: Bearer ${setup_token}" \
    --header 'Content-Type: application/json' \
    --data '{}' "http://127.0.0.1:${app_port}/api/onboarding/complete"
  csrf_token="$(json_field "$setup_file" csrfToken)"
}

authenticate_session() {
  local session_file="$temp_dir/session.json"
  curl --fail --silent --show-error --cookie-jar "$temp_dir/session.cookie" --output "$session_file" \
    --header 'Content-Type: application/json' \
    --data "{\"adminToken\":\"${admin_token}\"}" \
    "http://127.0.0.1:${app_port}/api/session"
  csrf_token="$(json_field "$session_file" csrfToken)"
}

run_authenticated_analysis() {
  local output="$1"
  curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" --output "$output" \
    --header 'Content-Type: application/json' \
    --header "X-CSRF-Token: ${csrf_token}" \
    --data '{"kind":"manual"}' "http://127.0.0.1:${app_port}/api/digests/run"
}

wait_for_job_state() {
  local job_id="$1"
  local expected_state="$2"
  local attempt job_state
  for attempt in {1..100}; do
    curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" \
      "http://127.0.0.1:${app_port}/api/digests/jobs/${job_id}" >"$temp_dir/job-status.json"
    job_state="$(json_field "$temp_dir/job-status.json" status)"
    if [[ "$job_state" == "$expected_state" ]]; then return 0; fi
    if [[ "$job_state" == 'failed' ]]; then
      printf 'Digest job %s failed before reaching %s.\n' "$job_id" "$expected_state" >&2
      return 1
    fi
    sleep 0.2
  done
  printf 'Digest job %s did not reach %s before verification timed out.\n' "$job_id" "$expected_state" >&2
  return 1
}

history_count() {
  curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" "http://127.0.0.1:${app_port}/api/digests/history" \
    | node --input-type=module -e 'let body = ""; process.stdin.on("data", (chunk) => body += chunk); process.stdin.on("end", () => process.stdout.write(String(JSON.parse(body).length)));'
}

assert_fake_ha_analysis() {
  local analysis_file="$temp_dir/analysis.json"
  local report_id='' job_id=''
  complete_persisted_onboarding
  run_authenticated_analysis "$analysis_file"
  job_id="$(json_field "$analysis_file" jobId)"
  wait_for_job_state "$job_id" completed
  report_id="$(json_field "$temp_dir/job-status.json" reportId)"
  curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" "http://127.0.0.1:${app_port}/api/digests/${report_id}" >"$temp_dir/report.json"
  grep -F 'logmark' "$temp_dir/report.json" >/dev/null
  printf 'Verified fake-HA REST and mounted-log analysis.\n'

  run_quietly compose_environment restart app
  wait_for_http_status 200
  authenticate_session
  curl --silent --show-error --fail --header "Authorization: Bearer ${setup_token}" \
    "http://127.0.0.1:${app_port}/api/onboarding" >"$temp_dir/restarted-onboarding.json"
  grep -F '"completed":true' "$temp_dir/restarted-onboarding.json" >/dev/null
  curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" \
    "http://127.0.0.1:${app_port}/api/settings" >"$temp_dir/restarted-settings.json"
  grep -F '"retentionDays":90' "$temp_dir/restarted-settings.json" >/dev/null
  curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" \
    "http://127.0.0.1:${app_port}/api/digests/jobs/${job_id}" >"$temp_dir/restarted-job.json"
  [[ "$(json_field "$temp_dir/restarted-job.json" status)" == 'completed' ]]
  [[ "$(json_field "$temp_dir/restarted-job.json" reportId)" == "$report_id" ]]
  curl --silent --show-error --fail --cookie "$temp_dir/session.cookie" "http://127.0.0.1:${app_port}/api/digests/${report_id}" >"$temp_dir/restarted-report.json"
  grep -F 'logmark' "$temp_dir/restarted-report.json" >/dev/null
  printf 'Verified report retrieval after restart.\n'
  printf 'Verified persisted onboarding, settings, and report job after restart.\n'

  local before_count after_count failed_job_id
  before_count="$(history_count)"
  run_quietly compose_environment exec -T fake-ha node -e 'fetch("http://127.0.0.1:8123/control/fail", { method: "POST" }).then((response) => process.exit(response.status === 204 ? 0 : 1))'
  run_authenticated_analysis "$temp_dir/failed-analysis.json"
  failed_job_id="$(json_field "$temp_dir/failed-analysis.json" jobId)"
  wait_for_job_state "$failed_job_id" failed
  after_count="$(history_count)"
  [[ "$before_count" == "$after_count" ]]
  printf 'Verified fake-HA source failure without a new report.\n'
}

assert_startup_failure_is_logged() {
  local startup_output="$temp_dir/startup-failure.log"

  if TRUST_PROXY=not-a-boolean compose_environment run --rm --no-deps app >"$startup_output" 2>&1; then
    printf 'Invalid runtime configuration unexpectedly started the container.\n' >&2
    return 1
  fi

  run_quietly compose_environment run --rm --no-deps --entrypoint sh app -eu -c '
    test -s /data/logs/runtime.log
    grep -F runtime_startup_failure /data/logs/runtime.log >/dev/null
    grep -F runtime_startup_failed /data/logs/runtime.log >/dev/null
    if grep -Fq docker-runtime-verification-admin-token /data/logs/runtime.log || grep -Fq docker-runtime-verification-setup-token /data/logs/runtime.log; then
      printf "Startup log leaked a verification token.\n" >&2
      exit 1
    fi
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

start_local_compose() {
  if run_quietly compose_environment up --build --detach; then
    return 0
  fi

  if [[ -n "${VERIFY_DOCKER_PORT:-}" ]]; then
    return 1
  fi

  printf 'Retrying automatic verification port allocation after Compose startup failed.\n' >&2
  compose_environment down --volumes --remove-orphans >/dev/null 2>&1 || true
  reserve_port 0
  write_run_metadata
  release_port_reservation
  run_quietly compose_environment up --build --detach
}

main() {
  require_timeout_contract
  create_run_workspace
  reserve_verification_port
  recover_stale_verification_runs
  write_run_metadata

  if [[ "${1:-}" == '--preflight' ]]; then
    node --input-type=module -e '
      process.stdout.write(`${JSON.stringify({
        projectName: process.argv[1],
        workspace: process.argv[2],
        port: Number(process.argv[3])
      })}\n`);
    ' "$project_name" "$temp_dir" "$app_port"
    return 0
  fi

  deadline_started_at="$SECONDS"
  require_dependencies
  cp "$repository_root/tests/fixtures/ha/home-assistant.log" "$ha_log_file"
  chmod 0644 "$ha_log_file"
  release_port_reservation

  printf 'Validating local Docker runtime mode.\n'
  run_quietly compose_environment config --quiet
  compose_started=true
  start_local_compose
  wait_for_http_status 200
  assert_local_cookie_contract
  printf 'Verified local cookie contract.\n'
  assert_write_boundaries
  printf 'Verified write boundaries.\n'
  assert_fake_ha_analysis
  assert_restart_persistence
  printf 'Verified write boundaries and restart persistence.\n'
  assert_startup_failure_is_logged
  printf 'Verified secret-safe startup failure logging.\n'
  assert_unreadable_log_becomes_unhealthy
  run_quietly compose_environment down --volumes --remove-orphans

  printf 'Validating reverse-proxy Docker runtime mode.\n'
  run_quietly compose_proxy config --quiet
  run_quietly compose_proxy up --build --detach
  wait_for_http_status 200
  assert_reverse_proxy_cookie_contract

  printf 'Docker runtime verification passed.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
