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
  const emails = new Set<string>();
  for (const u of users) {
    const profile = await repo.getUser(u.sub);
    const isAdmin = profile?.memberships.some((m) => m.tenantId === tenant && m.role === 'admin');
    const isOperator = profile?.memberships.some(
      (m) => m.tenantId === PLATFORM_TENANT && m.role === 'operator',
    );
    if (isAdmin && !isOperator && u.email) emails.add(u.email);
  }
  return [...emails];
}
