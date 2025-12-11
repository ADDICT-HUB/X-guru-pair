#!/usr/bin/env bash
set -e
REPO="https://github.com/ADDICT-HUB/X-GURU.git"
TARGET_DIR="./X-GURU"
if [ -d "$TARGET_DIR" ]; then
  echo "Updating existing X-GURU in $TARGET_DIR"
  git -C "$TARGET_DIR" pull --rebase
else
  echo "Cloning X-GURU into $TARGET_DIR"
  git clone "$REPO" "$TARGET_DIR"
fi
# Install Node deps if package.json exists
if [ -f "$TARGET_DIR/package.json" ]; then
  (cd "$TARGET_DIR" && npm ci)
else
  echo "No package.json found in $TARGET_DIR"
fi
