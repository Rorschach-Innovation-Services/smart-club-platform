/**
 * Create the recipe knockout fixtures (T20 semis + finals) in smart club, with the SAME
 * refs medicoach already holds for them (ADR 0016).
 *
 *   npx sst shell --stage dev -- npx tsx src/create-recipe-knockouts.ts --tenant dolphins            # dry run
 *   npx sst shell --stage dev -- npx tsx src/create-recipe-knockouts.ts --tenant dolphins --confirm  # write
 *
 * Why: the medicoach bundle import built the later-phase fixtures that smart club never
 * generated (Plan-B series hold only the group stage) straight from the tenant recipe, as
 * `smartclub:<t>:fixture:recipe:<leagueKey>:<stream>:<slotId>`. For the sync to put their
 * results and resolved teams anywhere, smart club needs those fixtures too. One series per
 * competition stream, `s-mc-ko-<leagueKey>-<stream>`:
 *
 *   - each fixture carries `syncRef` = the recipe ref, so the sync maps it by that ref
 *     rather than the derived series/fixture ref;
 *   - sides are placeholders: `pos:<groupSeriesId>:<rank>` for a group position, and
 *     `win:<fixtureId>` for the winner of an earlier slot in the same series;
 *   - `dateTbc: true` on a placeholder date (the stream's last group-stage date), and no
 *     venue — so no clash gate or ground ledger counts them until a real date arrives;
 *   - released/approved/withheld exactly as the stream's group series are;
 *   - `participants` = the union of the group series' participants, so a team medicoach
 *     resolves into a slot is one of the series' own team ids.
 *
 * Groups are numbered as the medicoach exporter numbers them (medicoach-export-build.ts):
 * a stream's series sorted by their group label, Top before Bottom, then natural order.
 *
 * Idempotent: an existing `s-mc-ko-*` series is reported and left alone. Never deletes.
 * Fixture refs carry no personal data, so they are printed.
 */
import { pathToFileURL } from 'node:url';
import { groupPositionOf, winnerOf, loserOf } from '../../engine/src/formats.js';
import { refs, isRecipeKnockoutSeries, RECIPE_KNOCKOUT_SERIES_PREFIX } from './medicoach-bundle.js';
import { compareGroupLabels, parseSeriesName, slugify } from './medicoach-export-build.js';
import { recipesForTenant } from './medicoach-recipes/index.js';
import type { RecipeSlot, TenantRecipes } from './medicoach-recipes/index.js';
import type { Series, TenantConfig } from './types.js';

export { isRecipeKnockoutSeries };

export const knockoutSeriesId = (leagueKey: string, stream: string) =>
  `${RECIPE_KNOCKOUT_SERIES_PREFIX}${leagueKey}-${stream}`;

type Participant = NonNullable<Series['participants']>[number];

export interface KnockoutFixture {
  id: string;
  round: number;
  date: string;
  dateTbc: true;
  home: string;
  away: string;
  stage: string;
  syncRef: string;
}

export interface KnockoutPlan {
  series: Series[];
  warnings: string[];
}

/** The Plan-B group series of one league stream, in exporter group order. */
function streamGroups(all: Series[], leagueKey: string, stream: string): Series[] {
  return all
    .filter(
      (s) =>
        s.leagueKey === leagueKey &&
        !s.seasonRunId &&
        !isRecipeKnockoutSeries(s.id) &&
        slugify(parseSeriesName(s.name).streamLabel ?? '') === stream,
    )
    .sort((a, b) =>
      compareGroupLabels(
        parseSeriesName(a.name).groupLabel ?? '',
        parseSeriesName(b.name).groupLabel ?? '',
      ),
    );
}

/**
 * Build (not write) one knockout series per recipe stream with later fixtures. Pure:
 * reads the stored series and the recipes, returns the series to create.
 */
export function planRecipeKnockouts(
  tenant: string,
  allSeries: Series[],
  recipes: TenantRecipes,
  config?: Pick<TenantConfig, 'leagues'> | null,
): KnockoutPlan {
  const out: Series[] = [];
  const warnings: string[] = [];
  for (const [leagueKey, league] of Object.entries(recipes.leagues)) {
    if (recipes.excludeLeagues?.[leagueKey]) continue;
    for (const [stream, comp] of Object.entries(league.competitions)) {
      const later = comp.laterFixtures ?? [];
      if (!later.length) continue;
      const groups = streamGroups(allSeries, leagueKey, stream);
      if (!groups.length) {
        warnings.push(`${leagueKey} ${stream}: no group series found — knockout not created`);
        continue;
      }
      const fixtureIdOf = new Map(later.map((lf, i) => [lf.slotId, `f${i + 1}`]));
      const side = (slot: RecipeSlot, where: string): string | null => {
        if (slot.kind === 'group-position') {
          const g = groups[slot.group - 1];
          if (!g) {
            warnings.push(
              `${leagueKey} ${stream} ${where}: recipe names group ${slot.group}, only ${groups.length} group series exist`,
            );
            return null;
          }
          return groupPositionOf(String(g.id), slot.position);
        }
        const target = fixtureIdOf.get(slot.of);
        if (!target) {
          warnings.push(`${leagueKey} ${stream} ${where}: unknown slot "${slot.of}"`);
          return null;
        }
        return slot.kind === 'winner' ? winnerOf(target) : loserOf(target);
      };
      // Placeholder date: the stream's last group-stage date (the real date is set later,
      // in medicoach or the console, and arrives through the sync).
      const dates = groups
        .flatMap((g) => (g.fixtures as Array<{ date?: string }>).map((f) => f?.date))
        .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      const placeholder = dates[dates.length - 1] ?? String(groups[0].startDate);
      const fixtures: KnockoutFixture[] = [];
      for (const lf of later) {
        const home = side(lf.home, `${lf.slotId} home`);
        const away = side(lf.away, `${lf.slotId} away`);
        if (!home || !away) continue;
        fixtures.push({
          id: fixtureIdOf.get(lf.slotId)!,
          round: lf.round,
          date: placeholder,
          dateTbc: true,
          home,
          away,
          stage: lf.stage,
          syncRef: refs.recipeFixture(tenant, leagueKey, stream, lf.slotId),
        });
      }
      if (fixtures.length !== later.length) continue; // warned above; never half a bracket

      const participants: Participant[] = [];
      const seen = new Set<string>();
      for (const g of groups)
        for (const p of g.participants ?? [])
          if (!seen.has(p.teamId)) {
            seen.add(p.teamId);
            participants.push(p);
          }
      const lifecycle = groups[0];
      const label =
        (config?.leagues ?? []).find((l) => l.key === leagueKey)?.label ??
        String(lifecycle.name).split('·')[0].trim();
      const streamLabel = parseSeriesName(lifecycle.name).streamLabel ?? comp.name;
      out.push({
        id: knockoutSeriesId(leagueKey, stream),
        name: `${label} · ${streamLabel} · Knockout`,
        leagueKey,
        startDate: placeholder,
        endDate: placeholder,
        dateMode: 'reference',
        teams: participants.map((p) => p.teamId),
        participants,
        fixtures,
        ...(lifecycle.maxOvers !== undefined ? { maxOvers: lifecycle.maxOvers } : {}),
        ...(lifecycle.seriesType !== undefined ? { seriesType: lifecycle.seriesType } : {}),
        kind: 'series',
        approved: lifecycle.approved ?? false,
        approvedAt: lifecycle.approvedAt ?? null,
        released: lifecycle.released ?? false,
        releasedAt: lifecycle.released ? (lifecycle.releasedAt ?? null) : null,
        ...(lifecycle.withheld ? { withheld: lifecycle.withheld } : {}),
        version: 1,
      } as Series);
    }
  }
  return { series: out, warnings };
}

interface Args {
  tenant: string;
  confirm: boolean;
}

export function parseArgs(argv: string[]): Args {
  let tenant = '';
  let confirm = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') tenant = argv[++i] ?? '';
    else if (a === '--confirm') confirm = true;
    else
      throw new Error(`unknown flag ${a}\nusage: create-recipe-knockouts --tenant <t> [--confirm]`);
  }
  if (!tenant) throw new Error('usage: create-recipe-knockouts --tenant <t> [--confirm]');
  return { tenant, confirm };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = await import('./repo.js');
  const [allSeries, config] = await Promise.all([
    repo.listSeries(args.tenant),
    repo.getTenantConfig(args.tenant),
  ]);
  const plan = planRecipeKnockouts(args.tenant, allSeries, recipesForTenant(args.tenant), config);
  for (const w of plan.warnings) console.warn(`⚠ ${w}`);
  const existing = new Set(allSeries.map((s) => String(s.id)));
  let fixtures = 0;
  let written = 0;
  for (const s of plan.series) {
    const exists = existing.has(s.id);
    const lifecycle = s.released ? 'released' : s.approved ? 'approved' : 'draft';
    console.log(
      `\n── ${s.id}  (${s.name} · ${lifecycle})${exists ? '  [exists — left alone]' : ''}`,
    );
    for (const f of s.fixtures as KnockoutFixture[]) {
      fixtures++;
      console.log(
        `  ${f.id}  ${f.stage}  ${f.home} v ${f.away}  date TBC (${f.date})  ${f.syncRef}`,
      );
    }
    if (!exists && args.confirm) {
      await repo.putSeries(args.tenant, s);
      written++;
    }
  }
  console.log(
    `\n${plan.series.length} knockout series, ${fixtures} fixtures.` +
      (args.confirm
        ? ` Wrote ${written} new series.`
        : ' [dry-run] nothing written — re-run with --confirm.'),
  );
  if (plan.warnings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
