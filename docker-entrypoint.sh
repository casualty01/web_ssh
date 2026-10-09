#!/bin/sh
set -e

# When /data is a freshly-created named volume (or a bind mount owned by
# root/another uid), it shadows any ownership set at image-build time.
# Fix it here, every start, before dropping privileges.
mkdir -p "${DATA_DIR:-/data}"
chown -R webssh:webssh "${DATA_DIR:-/data}"

exec su-exec webssh:webssh /app/webssh "$@"
