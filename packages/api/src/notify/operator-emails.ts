/**
 * Resolve the PLATFORM OPERATORS' email addresses (the internal team), via the
 * PLATFORM#OPERATORS marker index (`operatorGsi1`). The deliberate counterpart of
 * admin-emails.ts, which excludes operators: notices meant for the internal team (e.g. a chair's
 * scorecard correction request) go here and never to tenant admins. Kept free of the Hono app.
 */
type OperatorEmailRepo = Pick<typeof import('../repo.js'), 'listOperators'>;

const EMAIL_RE = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/;

/** Every operator's address — lower-cased, deduped, rows without a usable email left out. */
export async function listOperatorEmails(deps: { repo: OperatorEmailRepo }): Promise<string[]> {
  const operators = await deps.repo.listOperators();
  const emails = new Set<string>();
  for (const o of operators) {
    const email = typeof o.email === 'string' ? o.email.trim().toLowerCase() : '';
    if (email && EMAIL_RE.test(email)) emails.add(email);
  }
  return [...emails].sort();
}
