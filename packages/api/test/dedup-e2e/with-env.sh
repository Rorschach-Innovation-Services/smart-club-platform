#!/usr/bin/env bash
# Run a command against one dedup-battery scenario table (dynalite :4714 by default).
#   test/dedup-e2e/with-env.sh <table> <uploads-dir> <cmd...>
set -u
TABLE="$1"; UPLOADS="$2"; shift 2
export TABLE_NAME="$TABLE"
export DYNAMO_ENDPOINT="http://localhost:${DEDUP_E2E_DDB_PORT:-4714}"
export LOCAL_AUTH=1 STAGE=local LOCAL_UPLOADS_DIR="$UPLOADS" USER_POOL_ID=test-pool
export AWS_REGION=localhost UPLOADS_BUCKET=test-uploads AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_MAX_ATTEMPTS=1
mkdir -p "$UPLOADS"
cd "$(dirname "$0")/../.." || exit 99
"$@"
