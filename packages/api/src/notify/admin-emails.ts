/**
 * Resolve a tenant's admin recipients for union-office notices (sync conflicts, new clearances,
 * the clearance-reminder digest). Kept free of the Hono app (index.ts) so crons can use it.
 *
 * Platform operators are left out even when they hold an admin membership (operator auto-admin):
 * they see every tenant in the console and would otherwise get every tenant's notices.
 */
import { PLATFORM_TENANT } from '../types.js';

type AdminEmailRepo = Pick<typeof import('../repo.js'), 'listTenantUsers' | 'getUser'>;

export async function listTenantAdminEmails(
  repo: AdminEmailRepo,
  tenant: string,
): Promise<string[]> {
  const users = await repo.listTenantUsers(tenant);
  // The profile reads are independent — run them together rather than one round-trip per user.
  const profiles = await Promise.all(users.map((u) => repo.getUser(u.sub)));
  const emails = new Set<string>();
  users.forEach((u, i) => {
    const profile = profiles[i];
    const isAdmin = profile?.memberships.some((m) => m.tenantId === tenant && m.role === 'admin');
    const isOperator = profile?.memberships.some(
      (m) => m.tenantId === PLATFORM_TENANT && m.role === 'operator',
    );
    if (isAdmin && !isOperator && u.email) emails.add(u.email);
  });
  return [...emails];
}

/** A lazily-resolved, memoised admin list (see adminEmailsProvider). */
export type AdminEmailsProvider = () => Promise<string[]>;

/**
 * Memoise listTenantAdminEmails for ONE request / invocation: the first call reads, later calls
 * reuse the same promise, so several notices in one request cost one listing. A rejected read is
 * not cached (the next call retries). Create one per request — never share across requests, or a
 * newly invited admin would be missed until the process recycles.
 */
export function adminEmailsProvider(repo: AdminEmailRepo, tenant: string): AdminEmailsProvider {
  let pending: Promise<string[]> | null = null;
  return () => {
    if (!pending) {
      pending = listTenantAdminEmails(repo, tenant).catch((err: unknown) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}
