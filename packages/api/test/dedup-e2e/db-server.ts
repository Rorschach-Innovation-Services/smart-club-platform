/**
 * A standalone dynalite for the dedup CLI battery. Stays up until killed.
 *   npx tsx test/dedup-e2e/db-server.ts            (port 4714, DEDUP_E2E_DDB_PORT overrides)
 * Tables are created per scenario by seed.ts (create-table.ts).
 */
import type { Server } from 'node:http';
import { DDB_PORT } from './env.js';

const dynalite = (await import('dynalite')).default as (opts?: unknown) => Server;
const server = dynalite({ createTableMs: 0 });
await new Promise<void>((resolve) => server.listen(DDB_PORT, resolve));
console.log(`dedup-e2e dynalite on :${DDB_PORT}`);
