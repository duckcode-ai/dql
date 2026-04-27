#!/bin/sh
set -eu

log() {
  printf '[dql-docker] %s\n' "$*"
}

workspace="${DQL_PROJECT_ROOT:-${DQL_WORKSPACE:-/workspace}}"
demo_root="${DQL_DEMO_ROOT:-$workspace/.dql/docker-starter/acme-bank}"
template_root="/opt/dql/templates/acme-bank"

is_dql_source_repo() {
  [ -f "$workspace/package.json" ] \
    && [ -f "$workspace/pnpm-workspace.yaml" ] \
    && grep -q '"name": "dql"' "$workspace/package.json"
}

ensure_demo_project() {
  if [ -f "$demo_root/dql.config.json" ]; then
    return 0
  fi

  if [ ! -d "$template_root" ]; then
    log "Bundled Acme Bank template not found at $template_root."
    log "Run from a folder with dql.config.json, or rebuild the image."
    exit 1
  fi

  log "No DQL project found at $workspace."
  log "Creating Acme Bank starter project at $demo_root."
  mkdir -p "$demo_root"
  cp -R "$template_root/." "$demo_root/"
}

maybe_use_demo_project() {
  if [ -f "$workspace/dql.config.json" ]; then
    cd "$workspace"
    return 0
  fi

  if is_dql_source_repo; then
    ensure_demo_project
    cd "$demo_root"
    log "Using starter project: $demo_root"
    return 0
  fi

  cd "$workspace"
}

if [ "${1:-}" = "dql" ]; then
  case "${2:-}" in
    notebook|slack|compile|app|agent|verify|schedule|mcp|lineage)
      maybe_use_demo_project
      ;;
  esac
fi

exec "$@"
