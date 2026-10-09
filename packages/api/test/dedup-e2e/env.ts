/**
 * Duplicate-remediation CLI battery (E2E-FINDINGS.md): shared env for every child process.
 * The battery spawns the REAL CLIs (tsx src/resolve-duplicate-players.ts …) against a dynalite
 * this harness owns, one table per scenario. Never ports 3333/3201/4567 — the battery uses 4714.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DDB_PORT = Number(process.env.DEDUP_E2E_DDB_PORT ?? 4714);
export const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function childEnv(table: string, uploadsDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TABLE_NAME: table,
    DYNAMO_ENDPOINT: `http://localhost:${DDB_PORT}`,
    LOCAL_AUTH: '1',
    STAGE: 'local',
    LOCAL_UPLOADS_DIR: uploadsDir,
    USER_POOL_ID: 'test-pool',
    AWS_REGION: 'localhost',
    UPLOADS_BUCKET: 'test-uploads',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_MAX_ATTEMPTS: '1',
  };
}
