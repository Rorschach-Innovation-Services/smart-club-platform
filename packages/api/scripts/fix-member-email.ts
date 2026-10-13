/**
 * No-send email correction for a member who has never signed in: relocates the Cognito
 * sign-in alias, rewrites the USER#<sub> record (+ every tenant marker), and optionally one
 * club exco slot's email. Mirrors PATCH /admin/users/:sub/email (index.ts) minus the invite
 * re-send — NOTHING is sent (no notify module is imported).
 *
 *   sst shell --stage <stage> -- npx tsx packages/api/scripts/fix-member-email.ts \
 *     --tenant=dolphins --from=old@x.com --to=new@x.com [--club=<id> --slot=sec]   (dry run)
 *   … --confirm                                                                     (writes)
 *
 * Order (load-bearing): resolve the member from the tenant ROSTER markers (not the Cognito
 * alias) → guards (member of tenant, never signed in, --to free in the roster) → Cognito
 * (AliasExistsException stops BEFORE any DynamoDB write) → fresh getUser + putUser → exco
 * slot via repo.updateClub (the admin club PATCH path) with only that one email changed.
 *
 * Re-runnable: Cognito already on --to counts as success; a roster that already shows --to
 * for the member reports "already corrected" (the exco step still runs if given).
 *
 * Exit status: 1 for a bad/unknown flag, a failed guard, or an alias collision; else 0.
 */
import { pathToFileURL } from 'node:url';

const USAGE =
  'usage: fix-member-email --tenant=<id> --from=<old email> --to=<new email> ' +
  '[--club=<clubId> --slot=<exco key>] [--confirm]';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FixMemberEmailArgs {
  tenant: string;
  from: string;
  to: string;
  club?: string;
  slot?: string;
  confirm: boolean;
}

/** Parse the CLI flags; throws (message = the reason) on anything bad or unknown. Pure. */
export function parseFixMemberEmailArgs(argv: string[]): FixMemberEmailArgs {
  const out: Partial<FixMemberEmailArgs> & { confirm: boolean } = { confirm: false };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=').trim();
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--dry-run') out.confirm = false;
    else if (flag === '--tenant' && value) out.tenant = value;
    else if (flag === '--from' && value) out.from = value.toLowerCase();
    else if (flag === '--to' && value) out.to = value.toLowerCase();
    else if (flag === '--club' && value) out.club = value;
    else if (flag === '--slot' && value) out.slot = value;
    else throw new Error(`unknown or empty flag "${arg}"`);
  }
  if (!out.tenant) throw new Error('--tenant is required');
  if (!out.from) throw new Error('--from is required');
  if (!out.to) throw new Error('--to is required');
  if (!EMAIL_RE.test(out.to)) throw new Error(`--to is not a valid email: ${out.to}`);
  if (out.from === out.to) throw new Error('--from and --to are the same address');
  if (!!out.club !== !!out.slot) throw new Error('--club and --slot go together (both or neither)');
  return out as FixMemberEmailArgs;
}

type RepoModule = typeof import('../src/repo.js');

export interface FixMemberEmailDeps {
  repo: RepoModule;
  /** The user's current Cognito email (by sub), or null when unknown. */
  getCognitoEmail: (sub: string) => Promise<string | null>;
  /** adminUpdateCognitoUserEmail bound to the pool. */
  updateCognitoEmail: (sub: string, currentEmail: string, newEmail: string) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Run the correction (dry run prints only). Returns the exit status. */
export async function runFixMemberEmail(
  args: FixMemberEmailArgs,
  deps: FixMemberEmailDeps,
): Promise<number> {
  const { repo } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? (() => new Date());
  const { tenant, from, to } = args;
  log(
    `${args.confirm ? 'CONFIRM' : 'DRY RUN'} tenant=${tenant} from=${from} to=${to}` +
      (args.club ? ` club=${args.club} slot=${args.slot}` : ''),
  );

  const roster = await repo.listTenantUsers(tenant);
  const lc = (e: string) => e.trim().toLowerCase();
  const member = roster.find((u) => lc(u.email) === from);
  const summary: string[] = [];

  if (!member) {
    const holder = roster.find((u) => lc(u.email) === to);
    if (!holder) {
      log(`member NOT FOUND: no roster entry in "${tenant}" holds ${from} (or ${to})`);
      return 1;
    }
    log(`already corrected: roster sub=${holder.sub} already holds ${to}; nothing to move`);
    summary.push('Cognito: untouched (already corrected)', 'USER record: untouched');
  } else {
    const profile = await repo.getUser(member.sub);
    const inTenant = !!profile?.memberships.some((m) => m.tenantId === tenant);
    const neverSignedIn = !!profile && !profile.lastLoginAt;
    const taken = roster.find((u) => u.sub !== member.sub && lc(u.email) === to);
    const guards: Array<[string, boolean, string]> = [
      ['member belongs to tenant', inTenant, profile ? 'no membership' : 'no USER record'],
      ['never signed in', neverSignedIn, `lastLoginAt=${profile?.lastLoginAt ?? '?'}`],
      ['--to free in roster', !taken, `held by sub=${taken?.sub}`],
    ];
    log(`member: sub=${member.sub} role=${member.role}`);
    for (const [name, ok, why] of guards) log(`  guard ${name}: ${ok ? 'PASS' : `FAIL (${why})`}`);
    const failed = guards.some(([, ok]) => !ok);
    if (failed && args.confirm) {
      log('ABORTED: a guard failed — nothing written');
      return 1;
    }

    const cognitoEmail = await deps.getCognitoEmail(member.sub);
    const cognitoDone = cognitoEmail !== null && lc(cognitoEmail) === to;
    log(
      `  Cognito: ${cognitoDone ? `already ${to} (no change)` : `would set email ${cognitoEmail ?? from} → ${to} (email_verified=true, no message)`}`,
    );
    log(
      `  USER#${member.sub}: would set email ${profile?.email ?? '?'} → ${to} (+ tenant markers)`,
    );

    if (args.confirm) {
      if (!cognitoDone) {
        try {
          await deps.updateCognitoEmail(member.sub, profile!.email, to);
        } catch (err: unknown) {
          if ((err as { name?: string }).name === 'AliasExistsException') {
            log(
              `STOPPED: ${to} is already a sign-in alias for a DIFFERENT Cognito user ` +
                '(possibly in another tenant — the roster guard cannot see those). ' +
                'Nothing was written to DynamoDB. The fix here is to repoint the membership ' +
                'to that existing account, not to relocate the alias.',
            );
            return 1;
          }
          throw err;
        }
        summary.push(`Cognito: ${cognitoEmail ?? from} → ${to}`);
      } else summary.push(`Cognito: already ${to}`);
      // Fresh read immediately before the wholesale META write — a stale read would
      // clobber memberships changed since the guard read.
      const fresh = await repo.getUser(member.sub);
      if (!fresh) {
        log(`USER#${member.sub} vanished before the write — Cognito moved, DynamoDB untouched`);
        return 1;
      }
      await repo.putUser({ ...fresh, email: to });
      summary.push(`USER record: ${fresh.email} → ${to} (markers reconciled)`);
    }
  }

  if (args.club && args.slot) {
    const club = await repo.getClub(tenant, args.club);
    const officer = club?.exco?.[args.slot] as Record<string, unknown> | undefined;
    const current = typeof officer?.email === 'string' ? officer.email : undefined;
    if (!club) {
      log(`  exco: club ${args.club} NOT FOUND — skipped`);
      summary.push('exco slot: skipped (club not found)');
    } else if (!officer || current === undefined || lc(current) !== from) {
      log(`  exco.${args.slot}.email is ${current ?? '(none)'}, not ${from} — skipped`);
      summary.push(`exco slot: skipped (${current ?? 'no email'})`);
    } else {
      log(`  exco.${args.slot}.email: would set ${current} → ${to}`);
      if (args.confirm) {
        const exco = { ...club.exco, [args.slot]: { ...officer, email: to } };
        // Same path as the admin club PATCH; the version pins this to the read we inspected.
        await repo.updateClub(
          tenant,
          club.id,
          { exco, version: club.version ?? 0 },
          'fix-member-email',
          now().toISOString(),
        );
        summary.push(`exco slot: ${args.club}.${args.slot} ${current} → ${to}`);
      }
    }
  }

  if (!args.confirm) {
    log('DRY RUN done: nothing written. Re-run with --confirm to apply.');
    return 0;
  }
  log('summary:');
  for (const s of summary) log(`  ${s}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: FixMemberEmailArgs;
  try {
    args = parseFixMemberEmailArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n${USAGE}`);
    return 1;
  }
  const [repo, cognitoUsers, env, sdk] = await Promise.all([
    import('../src/repo.js'),
    import('../src/cognito-users.js'),
    import('../src/env.js'),
    import('@aws-sdk/client-cognito-identity-provider'),
  ]);
  let poolId: string;
  try {
    poolId = env.userPoolId();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const cognito = new sdk.CognitoIdentityProviderClient({});
  return runFixMemberEmail(args, {
    repo,
    getCognitoEmail: async (sub) => {
      try {
        const got = await cognito.send(
          new sdk.AdminGetUserCommand({ UserPoolId: poolId, Username: sub }),
        );
        return got.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? null;
      } catch {
        return null; // unknown — the update path (sub, then alias fallback) decides
      }
    },
    updateCognitoEmail: (sub, current, next) =>
      cognitoUsers.adminUpdateCognitoUserEmail(cognito, poolId, sub, current, next),
  });
}

// Only run as a CLI — a test imports the helpers / runFixMemberEmail directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((status) => process.exit(status))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
