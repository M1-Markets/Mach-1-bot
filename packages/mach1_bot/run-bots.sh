#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--instance alpha|beta]"
  exit 1
}

instance=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance|-i)
      instance="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      ;;
  esac
done

if [[ -n "$instance" ]]; then
  npx mach-one-bot run --instance "$instance"
  exit 0
fi

cleanup() {
  if [[ -n "${pid_alpha:-}" ]]; then
    kill "$pid_alpha" 2>/dev/null || true
  fi
  if [[ -n "${pid_beta:-}" ]]; then
    kill "$pid_beta" 2>/dev/null || true
  fi
}

trap cleanup INT TERM

npx mach-one-bot run --instance alpha &
pid_alpha=$!

npx mach-one-bot run --instance beta &
pid_beta=$!

wait "$pid_alpha"
wait "$pid_beta"
