#!/bin/bash

set -euo pipefail

# Read .env file and extract SSH configuration
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

SSH_HOST=${SIO_NEXUS_SSH_HOST}
SSH_USER=${SIO_NEXUS_SSH_USERNAME}
SSH_PORT=${SIO_NEXUS_SSH_PORT}

echo "🔄 Building SIO-NEXUS..."
bun typecheck && bun run build
echo "🚀 Starting SIO-NEXUS deployment to ${SSH_USER}@${SSH_HOST}:${SSH_PORT}..."
rsync -avz -e "ssh -p ${SSH_PORT}" ./build/x64/sio-nexus ${SSH_USER}@${SSH_HOST}:~/sio-nexus/sio-nexus
echo "File copied to remote server."
sleep 2
echo "Restarting process..."
ssh -t -p ${SSH_PORT} ${SSH_USER}@${SSH_HOST} "sudo systemctl restart sio-nexus"
echo "New version deployed and started."
