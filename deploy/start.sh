#!/bin/sh
# Without backup storage configured (local runs), the server runs on its own.
set -e
if [ -z "$BUCKET_NAME" ]; then exec node dist/server/main.js; fi
# A fresh volume starts from the last backup; an existing database is kept.
litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists /data/sfo.db
exec litestream replicate -config litestream.yml -exec "node dist/server/main.js"
