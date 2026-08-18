/**
 * Configure a tenant's compliance-doc catalogue (TenantConfig.requiredDocs, ADR 0009).
 *
 *   npx sst shell --stage <stage> -- npm --prefix packages/api run configure-tenant-docs -- titans
 *   … --confirm
 *
 * The operator console's "Required documents" card is the normal way to do this. This
 * script exists for the one case the card is a poor fit: standing up a whole catalogue at
 * once ahead of a bulk import, where the exact key set is load-bearing (the Titans import
 * aborts unless resolveRequiredDocs(config) covers every key it writes) and hand-entering
 * ten entries invites a typo that only surfaces mid-import.
 *
 * Writes through `repo` but re-runs `validateRequiredDocs` first — the same assertion the
 * operator route applies — so this path can never store a catalogue the API would reject
 * (the seed-cohort precedent; config-validation.ts was extracted for exactly this).
 * Idempotent: re-running with the same catalogue is a no-op diff.
 */
import { pathToFileURL } from 'node:url';
import { validateRequiredDocs } from './config-validation.js';
import { resolveRequiredDocs } from './catalogue.js';
import type { RequiredDoc } from './types.js';

/**
 * Titans 2026-27, from the union's circulated pack. `accepts` carries the spreadsheet
 * formats because most of these are filled-in workbooks, not PDFs. The two multi-file
 * caps are sized off the real pack: Centurion Kavaliers submitted 3 AGM documents and
 * Irene Villagers 4 distinct facility MOUs (7 files, 3 byte-identical copies that dedupe
 * away). `matchHints` feed the operator bulk-intake classifier — note the deliberate
 * "databse" misspelling, which is how most clubs' files actually arrived.
 */
const OFFICE = ['pdf', 'doc', 'docx'] as const;
const SHEET = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ods'] as const;

const CATALOGUES: Record<string, RequiredDoc[]> = {
  titans: [
    {
      key: 'leagueEntry',
      name: 'Club league entry',
      desc: 'Your completed 2026-27 league entry form',
      accepts: [...SHEET],
      matchHints: ['league entry'],
    },
    {
      key: 'assetsRegister',
      name: 'Club assets register',
      desc: 'Register of club assets for 2026-27',
      accepts: [...SHEET],
      matchHints: ['assets register'],
    },
    {
      key: 'healthTracker',
      name: 'Club health tracker',
      desc: 'Completed club health tracker',
      accepts: [...SHEET],
      matchHints: ['health tracker'],
    },
    {
      key: 'memberDatabase',
      name: 'Member database',
      desc: 'Full player/member register for the season',
      accepts: [...SHEET],
      matchHints: ['database', 'databse', 'player list', 'members database'],
    },
    {
      key: 'committee',
      // Deliberately NOT keyed `exco`: that key is the on-platform committee FORM, and a
      // form doc is satisfied by completing the form. Reusing it for a file upload would
      // let the form silently satisfy a required document (ADR 0009).
      name: 'Club committee',
      desc: 'Committee list for 2026-27',
      accepts: [...SHEET],
      matchHints: ['committee'],
    },
    {
      key: 'constitution',
      name: 'Club constitution',
      desc: 'Your club’s adopted constitution',
      accepts: [...OFFICE],
      matchHints: ['constitution'],
    },
    {
      key: 'agm',
      name: 'AGM pack',
      desc: 'AGM notice, agenda and minutes',
      multiFile: true,
      minFiles: 1,
      maxFiles: 6,
      accepts: [...OFFICE],
      matchHints: ['agm', 'annual general'],
    },
    {
      key: 'chairmansReport',
      name: 'Chairman’s report',
      desc: 'Chairperson’s report to the AGM',
      accepts: [...OFFICE],
      matchHints: ['chairman'],
    },
    {
      key: 'financials',
      name: 'Financial statements',
      desc: 'Annual financial statements for the prior season',
      allowUnavailable: true,
      accepts: [...OFFICE],
      matchHints: ['financial'],
    },
    {
      // ARCHIVED, not dropped. Titans collects its committee as a FILE (`committee`
      // above), so the on-platform exco form is not part of their requirements — but a
      // club already has docs.exco set from saving that form, and removing a key any club
      // holds data for is exactly what the referrer guard blocks (it would orphan the
      // record). Archiving keeps the key, excludes it from completion counts and upload
      // flows, and stops the form gate firing, since that checks the ACTIVE catalogue.
      key: 'exco',
      name: 'Executive committee (retired)',
      desc: 'Superseded by the Club committee document',
      kind: 'form',
      archived: true,
    },
    // Two more shared-default keys the existing admin-cc club holds data for. Same
    // reasoning as exco: Titans never required them, but the data exists, so they are
    // archived rather than dropped. Shapes match DEFAULT_REQUIRED_DOCS so the stored
    // records keep resolving the way they were written.
    {
      key: 'codeOfConduct',
      name: 'Code of conduct (retired)',
      desc: 'Not part of the Titans 2026-27 requirements',
      archived: true,
    },
    {
      key: 'safeguarding',
      name: 'Safeguarding certificates (retired)',
      desc: 'Not part of the Titans 2026-27 requirements',
      multiFile: true,
      minFiles: 2,
      maxFiles: 10,
      allowCourseBooked: true,
      archived: true,
    },
    {
      key: 'facilityAgreement',
      name: 'Facility agreements',
      desc: 'Lease, MOU or field-use agreement for every ground you play at',
      multiFile: true,
      minFiles: 1,
      maxFiles: 10,
      // Clubs at municipal grounds genuinely have no formal agreement — without this the
      // doc would be permanently unsatisfiable for them.
      allowUnavailable: true,
      accepts: [...OFFICE],
      matchHints: ['lease', 'mou', 'facility', 'field agreement', 'field use', 'agreement'],
    },
  ],
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const tenant = args.find((a) => !a.startsWith('--'));
  if (!tenant) throw new Error('usage: configure-tenant-docs <tenant> [--confirm]');

  const next = CATALOGUES[tenant];
  if (!next) {
    throw new Error(
      `no catalogue defined for "${tenant}" — add one to CATALOGUES in this file, or use the ` +
        "operator console's Required documents card.",
    );
  }
  // Same guard the operator route runs. Fails before any write.
  validateRequiredDocs(next);

  const repo = await import('./repo.js');
  const cfg = await repo.getTenantConfig(tenant);
  if (!cfg) throw new Error(`tenant "${tenant}" has no config — has it been created?`);

  const current = resolveRequiredDocs(cfg);
  const explicit = cfg.requiredDocs !== undefined;
  console.log(
    `\n── ${tenant}: ${explicit ? 'explicit catalogue' : 'no explicit catalogue (resolving to shared defaults)'}`,
  );
  console.log(`   current: ${current.map((d) => d.key).join(', ')}`);
  console.log(`   next:    ${next.map((d) => d.key).join(', ')}`);

  // Removing a key any club still holds data for is what the operator route 409s on;
  // surface the same information here rather than discovering it after the write.
  const nextKeys = new Set(next.map((d) => d.key));
  const removed = current.filter((d) => !nextKeys.has(d.key));
  if (removed.length) {
    const clubs = await repo.listClubs(tenant);
    for (const doc of removed) {
      const holders = clubs.filter(
        (c) => c.docs?.[doc.key] === true || (c.docMeta && doc.key in c.docMeta),
      );
      const label = holders.length
        ? `${holders.length} club(s) HOLD DATA: ${holders.map((c) => c.id).join(', ')}`
        : 'no club data';
      console.log(`   removing "${doc.key}" — ${label}`);
      if (holders.length) {
        throw new Error(
          `refusing to drop "${doc.key}" while ${holders.length} club(s) still hold data for it ` +
            '— archive it instead (set archived: true), or clear those clubs first.',
        );
      }
    }
  }

  if (!confirm) {
    console.log('\nDry run — re-run with --confirm to write.');
    return;
  }
  await repo.putTenantConfig({ ...cfg, requiredDocs: next });
  console.log(`\n✓ wrote ${next.length} required-doc definitions to ${tenant}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

export { CATALOGUES };
