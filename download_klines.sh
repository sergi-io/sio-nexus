#!/bin/bash

set -euo pipefail

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

SSH_HOST=${SIO_NEXUS_SSH_HOST:?Set SIO_NEXUS_SSH_HOST}
SSH_USER=${SIO_NEXUS_SSH_USERNAME:?Set SIO_NEXUS_SSH_USERNAME}
SSH_PORT=${SIO_NEXUS_SSH_PORT:?Set SIO_NEXUS_SSH_PORT}

ssh -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
  'sqlite3 ~/sio-nexus/data/klines.db "PRAGMA wal_checkpoint(TRUNCATE);" && \
   cp ~/sio-nexus/data/klines.db ~/sio-nexus/data/klines_backup.db'

rsync -avz --progress -e "ssh -p $SSH_PORT" \
  "$SSH_USER@$SSH_HOST:~/sio-nexus/data/klines_backup.db" \
  ./data/klines.db

sleep 1
sync

sqlite3 ./data/klines.db "PRAGMA integrity_check;"
