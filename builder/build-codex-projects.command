#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "$#" -eq 0 ]; then
  printf '请输入小红书 JSON 文件或目录路径，然后按回车：\n> '
  IFS= read -r INPUT_PATH
  if [ -z "$INPUT_PATH" ]; then
    printf '未提供输入。\n' >&2
    exit 1
  fi
  case "$INPUT_PATH" in
    \"*\") INPUT_PATH=${INPUT_PATH#\"}; INPUT_PATH=${INPUT_PATH%\"} ;;
    \'*\') INPUT_PATH=${INPUT_PATH#\'}; INPUT_PATH=${INPUT_PATH%\'} ;;
  esac
  # Finder/Terminal drag-and-drop commonly inserts backslash-escaped spaces.
  # Decode only that one harmless layer; never evaluate pasted shell text.
  INPUT_PATH=$(printf '%s' "$INPUT_PATH" | sed 's/\\ / /g')
  set -- -- "$INPUT_PATH"
fi

exec python3 "$SCRIPT_DIR/build_codex_projects.py" "$@"
