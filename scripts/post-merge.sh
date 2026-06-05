#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
pnpm --filter db push
