#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Collect pyproject.toml files from additionalMounts so deps can be
# pre-installed in the image, avoiding the per-container pip install cost.
DB_PATH="$(dirname "$SCRIPT_DIR")/store/messages.db"
rm -f extra-pyproject-*.toml
if [ -f "$DB_PATH" ] && command -v sqlite3 &>/dev/null; then
  CONFIGS=$(sqlite3 "$DB_PATH" "SELECT container_config FROM registered_groups WHERE container_config IS NOT NULL;" 2>/dev/null || true)
  if [ -n "$CONFIGS" ]; then
    while IFS= read -r config; do
      # Extract hostPath values from additionalMounts using basic parsing
      echo "$config" | grep -o '"hostPath":"[^"]*"' | sed 's/"hostPath":"//;s/"//' | while read -r host_path; do
        host_path="${host_path/#\~/$HOME}"
        if [ -f "$host_path/pyproject.toml" ]; then
          slug=$(echo "$host_path" | tr '/' '-' | tr -cd '[:alnum:]-' | tail -c 40)
          dest="extra-pyproject-${slug}.toml"
          cp "$host_path/pyproject.toml" "$dest"
          echo "Bundling deps from $host_path/pyproject.toml -> $dest"
        fi
      done
    done <<< "$CONFIGS"
  fi
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

rm -f extra-pyproject-*.toml

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
