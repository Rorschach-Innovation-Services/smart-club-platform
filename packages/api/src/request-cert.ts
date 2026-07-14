/**
 * request-cert — request (or reissue) an ACM certificate for the wildcard/vanity domain
 * rollout, printing the DNS-validation CNAMEs and the new ARN. Runs STANDALONE with
 * plain AWS credentials (NOT `sst shell` — it only touches ACM):
 *
 *   npm --prefix packages/api run request-cert -- \
 *     --region us-east-1 --replace <existing-web-cert-arn> \
 *     --add '*.club.medicoach.co.za' [--profile medicoach] [--no-wait]
 *
 *   npm --prefix packages/api run request-cert -- \
 *     --region af-south-1 --add 'api.club.medicoach.co.za' --profile medicoach
 *
 * --replace <arn>  reads the existing certificate's SANs (DescribeCertificate) and
 *                  requests a SUPERSET — mechanically guaranteeing no live SAN is dropped
 *                  (dropping one would break tenants already served by that cert).
 * --add <host>     a host to include (repeatable). At least one --add (or --replace) is
 *                  required. The union is de-duplicated.
 * --region <r>     us-east-1 for CloudFront (web), af-south-1 for API Gateway. Required.
 * --profile <p>    AWS named profile (sets AWS_PROFILE for the SDK). Optional.
 * --no-wait        request + print validation records, then exit without polling to ISSUED.
 *
 * Regions matter: a CloudFront viewer cert MUST be us-east-1; an HTTP API custom-domain
 * cert MUST be in the API's region (af-south-1). See docs/runbooks/wildcard-domain-rollout.md.
 */
import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
  type DomainValidation,
} from '@aws-sdk/client-acm';

interface Args {
  region?: string;
  replace?: string;
  add: string[];
  profile?: string;
  wait: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { add: [], wait: true };
  // Consume the value after a value-taking flag, erroring on a missing/flag-looking value
  // (a fat-fingered `--add` shouldn't crash later with a TypeError in a rollout CLI).
  const value = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith('--')) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--region') args.region = value(a, argv[++i]);
    else if (a === '--replace') args.replace = value(a, argv[++i]);
    else if (a === '--add') args.add.push(value(a, argv[++i]));
    else if (a === '--profile') args.profile = value(a, argv[++i]);
    else if (a === '--no-wait') args.wait = false;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** De-dupe (case-insensitive), keep first-seen order. */
function dedupeHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hosts) {
    const key = h.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h.trim());
  }
  return out;
}

/** Print the ACM DNS-validation CNAMEs as a cPanel-ready table. */
function printValidationRecords(validations: DomainValidation[]): void {
  console.log('\nDNS validation CNAME records (add these at the authoritative DNS zone):');
  console.log('  ' + 'NAME'.padEnd(60) + 'TYPE'.padEnd(8) + 'VALUE');
  for (const v of validations) {
    const rr = v.ResourceRecord;
    if (!rr) continue;
    console.log('  ' + (rr.Name ?? '').padEnd(60) + (rr.Type ?? '').padEnd(8) + (rr.Value ?? ''));
  }
  console.log(
    '\nACM de-duplicates validation records across SANs on the same domain, so you may see ' +
      'fewer rows than hosts. Keep these records PERMANENTLY — ACM reuses them at renewal.\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.region) {
    console.error('--region is required (us-east-1 for web/CloudFront, af-south-1 for API)');
    process.exit(1);
  }
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  const acm = new ACMClient({ region: args.region });

  // Build the SAN superset: existing cert SANs (when --replace) ∪ --add hosts.
  let hosts = [...args.add];
  if (args.replace) {
    const { Certificate } = await acm.send(
      new DescribeCertificateCommand({ CertificateArn: args.replace }),
    );
    const existing = Certificate?.SubjectAlternativeNames ?? [];
    if (existing.length === 0) {
      console.error(`could not read SANs from ${args.replace} — aborting so no host is dropped`);
      process.exit(1);
    }
    console.log(`existing certificate covers ${existing.length} host(s):`);
    for (const h of existing) console.log(`  - ${h}`);
    hosts = [...existing, ...args.add];
  }
  hosts = dedupeHosts(hosts);
  if (hosts.length === 0) {
    console.error('nothing to request — pass --replace <arn> and/or --add <host>');
    process.exit(1);
  }
  console.log(`\nrequesting a certificate in ${args.region} covering ${hosts.length} host(s):`);
  for (const h of hosts) console.log(`  - ${h}`);

  const [primary, ...sans] = hosts;
  const { CertificateArn } = await acm.send(
    new RequestCertificateCommand({
      DomainName: primary,
      SubjectAlternativeNames: sans.length ? sans : undefined,
      ValidationMethod: 'DNS',
    }),
  );
  if (!CertificateArn) {
    console.error('ACM did not return a certificate ARN');
    process.exit(1);
  }
  console.log(`\nrequested: ${CertificateArn}`);

  // Poll until the validation records are populated (they lag the request by a moment).
  let validations: DomainValidation[] = [];
  for (let i = 0; i < 20; i++) {
    const { Certificate } = await acm.send(new DescribeCertificateCommand({ CertificateArn }));
    validations = Certificate?.DomainValidationOptions ?? [];
    if (validations.every((v) => v.ResourceRecord)) break;
    await sleep(3000);
  }
  printValidationRecords(validations);

  if (!args.wait) {
    console.log(
      '--no-wait: exiting before validation. Re-run DescribeCertificate to check status.',
    );
    console.log(`\nARN (paste into infra/tenants.ts once ISSUED):\n${CertificateArn}`);
    return;
  }

  console.log('waiting for the certificate to be ISSUED (add the CNAMEs above first)…');
  // Poll up to ~40 min (validation is usually minutes once the CNAMEs resolve).
  for (let i = 0; i < 160; i++) {
    const { Certificate } = await acm.send(new DescribeCertificateCommand({ CertificateArn }));
    const status = Certificate?.Status;
    if (status === 'ISSUED') {
      console.log('\ncertificate ISSUED.');
      console.log(`\nARN (paste into infra/tenants.ts):\n${CertificateArn}`);
      return;
    }
    if (status === 'FAILED' || status === 'VALIDATION_TIMED_OUT') {
      console.error(`\ncertificate ${status}. Check the validation CNAMEs and retry.`);
      process.exit(1);
    }
    process.stdout.write('.');
    await sleep(15000);
  }
  console.error('\ntimed out waiting for ISSUED — the CNAMEs may not have propagated yet.');
  console.log(`ARN (check status later):\n${CertificateArn}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
