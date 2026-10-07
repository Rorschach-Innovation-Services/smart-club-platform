/* ─── Scouting → Pathways → Players, and Route to professional ───
 *
 * Players: performance from the youngest age bracket to the franchise — participation (balls
 * faced and bowled), averages, medians, boom and bust — with a benchmark at each bracket, the
 * outliers against it, and each player's own climb. Route to professional: where every player
 * is in the system (school, club, representative, franchise), where they came from, how many
 * games they play in each setting, who is coming in, who has gone, and where the gaps are.
 * The eye puts a player on the watch list shared with Player scouting. The numbers and rules
 * are in src/journeys.ts.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KPI, Pill, ScrollX } from './atoms';
import {
  BANDS,
  SETTING_LABEL,
  SETTINGS,
  average,
  ballsPerWicket,
  boards,
  boomBust,
  economy,
  flowBySeason,
  formatsOf,
  funnel,
  improversAcross,
  journeyOf,
  journeys,
  medianScore,
  rungOf,
  routesToPro,
  schoolOrigins,
  seasonsOf,
  settingMix,
  strikeRate,
  type BracketBoard,
  type BracketLine,
  type Disc,
  type Format,
  type Gender,
  type Journey,
  type JourneyPlayer,
} from './journeys';
import { JOURNEY_PLAYERS, JOURNEYS_ARE_SAMPLE } from './journeys-data';
import {
  BoomBustBars,
  BracketLadder,
  FlowBars,
  FunnelBars,
  InningsColumns,
  JourneyStrip,
  ParticipationBars,
  SettingMixBars,
  type InningsCol,
  type LadderCol,
} from './journeys-charts';
import { Figure } from './pathways-charts';
import { WatchButton, useWatchlist, watchKey, type Watchlist } from './scouting-player';

const f0 = (v: number | null) => (v === null ? '–' : Math.round(v).toString());
const f1 = (v: number | null) => (v === null ? '–' : v.toFixed(1));
const f2 = (v: number | null) => (v === null ? '–' : v.toFixed(2));
const pc = (v: number) => `${Math.round(v * 100)}%`;
const overs = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;
/** The watch list keys a player by name and a hub; a journey player's hub is its id. */
const watchId = (p: JourneyPlayer) => ({ name: p.name, hub: p.id });

function useJourneyData() {
  return useMemo(() => {
    const players = JOURNEY_PLAYERS;
    const seasons = seasonsOf(players);
    return {
      players,
      seasons,
      js: journeys(players),
      first: seasons[0],
      latest: seasons[seasons.length - 1],
    };
  }, []);
}

function useParam() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };
  return { get, set };
}

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="ml-seg" role="tablist" aria-label={label}>
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          className={value === k ? 'on' : ''}
          onClick={() => onChange(k)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const SampleNote = () =>
  JOURNEYS_ARE_SAMPLE ? (
    <p className="ml-note">
      <b>Sample data, invented players.</b> The schools, clubs, names and numbers here are made up
      to show what the dashboard will look like; the union&apos;s own player records replace them
      (see docs/scouting-pathways.md, &ldquo;Player journeys&rdquo;).
    </p>
  ) : null;

const STATUS_LABEL = { active: 'Active', new: 'New this season', exited: 'Left the data' } as const;
const STATUS_TONE = { active: 'teal', new: 'navy', exited: 'coral' } as const;

/* ═══════════════════════════ Players ═══════════════════════════ */

export function PlayerPerformance() {
  const { players, seasons, latest } = useJourneyData();
  const { get, set } = useParam();
  const watch = useWatchlist();
  const [all, setAll] = useState(false);
  const gender: Gender = get('jg') === 'women' ? 'women' : 'men';
  const formats = useMemo(() => formatsOf(players, gender), [players, gender]);
  const format = (
    formats.includes(get('jf') as Format) ? get('jf') : formats.includes('T20') ? 'T20' : formats[0]
  ) as Format | undefined;
  const disc: Disc = get('jd') === 'bowl' ? 'bowl' : 'bat';
  const bs = useMemo(
    () => (format ? boards(players, format, gender) : []),
    [players, format, gender],
  );
  const bracket = bs.find((b) => b.bracket === get('jb'))?.bracket ?? 'all';
  const needle = get('jq').trim().toLowerCase();
  const pickId = get('jp');

  const pctOf = (l: BracketLine) => (disc === 'bat' ? l.batPct : l.bowlPct);
  const isOut = (l: BracketLine) => (disc === 'bat' ? l.batOutlier : l.bowlOutlier);
  const inView = useMemo(
    () => bs.filter((b) => bracket === 'all' || b.bracket === bracket).flatMap((b) => b.lines),
    [bs, bracket],
  );
  const shown = useMemo(
    () =>
      inView
        .filter((l) => !needle || l.player.name.toLowerCase().includes(needle))
        .sort(
          (a, b) =>
            (pctOf(b) ?? -1) - (pctOf(a) ?? -1) ||
            (disc === 'bat' ? b.t.balls - a.t.balls : b.t.bBalls - a.t.bBalls),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inView, needle, disc],
  );
  const rated = inView.filter((l) => pctOf(l) !== null);
  const outliers = rated.filter(isOut).sort((a, b) => (pctOf(b) ?? 0) - (pctOf(a) ?? 0));
  const climbs = useMemo(
    () => improversAcross(bs, disc).filter((c) => bracket === 'all' || c.to.bracket === bracket),
    [bs, disc, bracket],
  );

  const cols: LadderCol[] = bs.map((b) => ({
    key: b.bracket,
    label: b.bracket,
    sub: `${(disc === 'bat' ? b.bat?.n : b.bowl?.n) ?? 0} rated`,
    spread: disc === 'bat' ? b.bat : b.bowl,
    points: b.lines.flatMap((l) => {
      const v = disc === 'bat' ? average(l.t) : economy(l.t);
      if (v === null || pctOf(l) === null) return [];
      return [
        {
          id: l.player.id,
          label: l.player.name,
          value: v,
          outlier: isOut(l),
          tip:
            disc === 'bat'
              ? `${l.player.name} · ${l.bracket} · average ${f1(average(l.t))} · median ${f0(medianScore(l.t))} · SR ${f0(strikeRate(l.t))} · ${l.t.balls} balls faced in ${l.t.inns} innings`
              : `${l.player.name} · ${l.bracket} · economy ${f2(economy(l.t))} · ${l.t.wkts} wickets · ${overs(l.t.bBalls)} overs bowled`,
        },
      ];
    }),
  }));
  const picked = pickId ? players.find((p) => p.id === pickId) : undefined;

  if (!format)
    return (
      <div className="ss-empty">
        No {gender === 'women' ? "girls' or women's" : "boys' or men's"} player records yet.
      </div>
    );

  return (
    <div>
      <SampleNote />
      <div className="ml-bar" role="group" aria-label="Player filters">
        <Seg
          label="Discipline"
          value={disc}
          options={[
            ['bat', 'Batting'],
            ['bowl', 'Bowling'],
          ]}
          onChange={(d) => set({ jd: d === 'bat' ? null : d })}
        />
        <Seg
          label="Gender"
          value={gender}
          options={[
            ['men', 'Boys & men'],
            ['women', 'Girls & women'],
          ]}
          onChange={(g) => set({ jg: g === 'men' ? null : g, jf: null, jb: null, jp: null })}
        />
        <Seg
          label="Format"
          value={format}
          options={formats.map((f) => [f, f] as [Format, string])}
          onChange={(f) => set({ jf: f })}
        />
        <select
          className="field-select"
          aria-label="Age bracket"
          value={bracket}
          onChange={(e) => set({ jb: e.target.value === 'all' ? null : e.target.value })}
          style={{ maxWidth: 170 }}
        >
          <option value="all">All age brackets</option>
          {bs.map((b) => (
            <option key={b.bracket} value={b.bracket}>
              {b.bracket}
            </option>
          ))}
        </select>
        <input
          className="field-input"
          type="search"
          placeholder="Find a player…"
          aria-label="Find a player"
          value={get('jq')}
          onChange={(e) => set({ jq: e.target.value || null })}
          style={{ maxWidth: 200 }}
        />
      </div>

      <div className="kpi-strip sc-kpis">
        <KPI
          label="Players"
          num={new Set(inView.map((l) => l.player.id)).size}
          sub={`${format} · ${bracket === 'all' ? 'every age bracket' : bracket}`}
        />
        <KPI
          label="Rated"
          num={new Set(rated.map((l) => l.player.id)).size}
          sub="enough balls to rate fairly"
        />
        <KPI label="Outliers" num={outliers.length} sub="top 10% and quick with it" />
        <KPI
          label="Climbers"
          num={climbs.length}
          sub="up 30+ percentile points on the bracket below"
        />
      </div>

      <Figure
        title="The bar at each age bracket"
        sub={
          disc === 'bat'
            ? 'Batting average (runs per dismissal) of every rated player, U9 to the franchise · each player against their own bracket, format and gender · the diamond is the benchmark to clear'
            : 'Economy (runs per over) of every rated bowler who took wickets · lower is better'
        }
      >
        <BracketLadder
          cols={cols}
          better={disc === 'bat' ? 'high' : 'low'}
          unit={disc === 'bat' ? 'Batting average' : 'Economy (runs per over)'}
          fmt={(v) => (disc === 'bat' ? v.toFixed(0) : v.toFixed(1))}
          selected={pickId || null}
          onPick={(id) => set({ jp: id })}
        />
      </Figure>

      <div className="pw-grid-2">
        <Figure
          title="Participation"
          sub="Median balls faced and bowled per player each season — how much of the game a player at this level actually gets"
        >
          <ParticipationBars
            rows={bs.map((b) => ({
              key: b.bracket,
              label: b.bracket,
              faced: b.ballsFaced,
              bowled: b.ballsBowled,
              players: b.lines.length,
            }))}
          />
        </Figure>
        {disc === 'bat' ? (
          <Figure
            title="Boom and bust"
            sub="Share of innings that are a bust (under the first mark), steady, or a boom (the second mark or more)"
          >
            <BoomBustBars
              rows={bs.map((b) => ({
                key: b.bracket,
                label: `${b.bracket} · <${BANDS[b.bracket][0]} / ${BANDS[b.bracket][1]}+`,
                bracket: b.bracket,
                ...b.boom,
              }))}
            />
          </Figure>
        ) : (
          <Figure
            title="Wicket-taking"
            sub="Median balls per wicket of the rated bowlers at each bracket · lower is better"
          >
            <div className="jn-rows">
              {bs.map((b) => {
                const bw = b.lines.flatMap((l) => {
                  const v = ballsPerWicket(l.t);
                  return v !== null && l.bowlPct !== null ? [v] : [];
                });
                const m = bw.length
                  ? [...bw].sort((a, c) => a - c)[Math.floor(bw.length / 2)]
                  : null;
                return (
                  <div key={b.bracket} className="jn-row">
                    <span>{b.bracket}</span>
                    <i style={{ width: `${m ? Math.min(100, (m / 60) * 100) : 0}%` }} />
                    <b>{m === null ? '–' : `${Math.round(m)} balls`}</b>
                  </div>
                );
              })}
            </div>
          </Figure>
        )}
      </div>

      <div className="pw-grid-2">
        <Figure
          title="Outliers"
          sub={`${format} · ${bracket === 'all' ? 'every bracket' : bracket} · top 10% on ${disc === 'bat' ? 'average' : 'economy'} and ahead of the middle on ${disc === 'bat' ? 'strike rate' : 'balls per wicket'}`}
        >
          <PlayerList
            lines={outliers.slice(0, 10)}
            disc={disc}
            watch={watch}
            pick={(id) => set({ jp: id })}
            empty="No outliers at this bracket yet."
          />
        </Figure>
        <Figure
          title="Climbers"
          sub="Rated at two brackets and 30+ percentile points higher at the later one — improving against their peers, not just getting older"
        >
          {climbs.length ? (
            <ul className="jn-list">
              {climbs.slice(0, 8).map((c) => (
                <li key={c.player.id + c.to.bracket}>
                  <button
                    type="button"
                    className="jn-name"
                    onClick={() => set({ jp: c.player.id })}
                  >
                    {c.player.name}
                  </button>
                  <span className="jn-sub">
                    {c.from.bracket} → {c.to.bracket}
                  </span>
                  <span className="jn-gain">
                    {(c.disc === 'bat' ? c.from.batPct : c.from.bowlPct) ?? '–'} →{' '}
                    {(c.disc === 'bat' ? c.to.batPct : c.to.bowlPct) ?? '–'}
                  </span>
                  <WatchButton player={watchId(c.player)} watch={watch} compact />
                </li>
              ))}
            </ul>
          ) : (
            <div className="pv-empty">No climbers at this bracket yet.</div>
          )}
        </Figure>
      </div>

      {picked && (
        <PlayerDetail
          player={picked}
          bs={bs}
          seasons={seasons}
          latest={latest}
          format={format}
          watch={watch}
          onClose={() => set({ jp: null })}
        />
      )}

      <Figure
        title="Players"
        sub={`${shown.length} line${shown.length === 1 ? '' : 's'} · one per player per age bracket · best-rated first · tap a row to follow that player up the ladder`}
      >
        <div className="tbl-w">
          <ScrollX label="Players">
            <table className="tbl sc-tbl pw-ladder jn-tbl" aria-label="Players">
              <thead>
                {disc === 'bat' ? (
                  <tr>
                    <th>Player</th>
                    <th>Age group</th>
                    <th className="num hide-narrow">Seasons</th>
                    <th className="num">Games</th>
                    <th className="num">Balls faced</th>
                    <th className="num">Avg</th>
                    <th className="num">Median</th>
                    <th className="num">SR</th>
                    <th className="num hide-narrow">Bust</th>
                    <th className="num hide-narrow">Boom</th>
                    <th>Rating</th>
                    <th aria-label="Watch" />
                  </tr>
                ) : (
                  <tr>
                    <th>Player</th>
                    <th>Age group</th>
                    <th className="num hide-narrow">Seasons</th>
                    <th className="num">Games</th>
                    <th className="num">Overs</th>
                    <th className="num">Econ</th>
                    <th className="num">Wkts</th>
                    <th className="num hide-narrow">Balls/wkt</th>
                    <th>Rating</th>
                    <th aria-label="Watch" />
                  </tr>
                )}
              </thead>
              <tbody>
                {(all ? shown : shown.slice(0, 40)).map((l) => {
                  const bb = boomBust(l.rows, l.bracket);
                  const pct = pctOf(l);
                  return (
                    <tr
                      key={l.player.id + l.bracket}
                      className={`pick ${pickId === l.player.id ? 'on' : ''}`}
                      onClick={() => set({ jp: l.player.id })}
                    >
                      <td>
                        <strong>{l.player.name}</strong>
                      </td>
                      <td>{l.bracket}</td>
                      <td className="num hide-narrow">{l.seasons.length}</td>
                      <td className="num">{l.t.games}</td>
                      {disc === 'bat' ? (
                        <>
                          <td className="num">{l.t.balls.toLocaleString()}</td>
                          <td className="num">{f1(average(l.t))}</td>
                          <td className="num">{f0(medianScore(l.t))}</td>
                          <td className="num">{f0(strikeRate(l.t))}</td>
                          <td className="num hide-narrow">{bb.n ? pc(bb.bust) : '–'}</td>
                          <td className="num hide-narrow">{bb.n ? pc(bb.boom) : '–'}</td>
                        </>
                      ) : (
                        <>
                          <td className="num">{overs(l.t.bBalls)}</td>
                          <td className="num">{f2(economy(l.t))}</td>
                          <td className="num">{l.t.wkts}</td>
                          <td className="num hide-narrow">{f0(ballsPerWicket(l.t))}</td>
                        </>
                      )}
                      <td>
                        {pct === null ? (
                          <span className="jn-sub">small sample</span>
                        ) : (
                          <span className="jn-pct" title={`${pct}th percentile in ${l.bracket}`}>
                            <i style={{ width: `${pct}%` }} />
                            <b>{pct}</b>
                            {isOut(l) && <Pill tone="gold">Outlier</Pill>}
                          </span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <WatchButton player={watchId(l.player)} watch={watch} compact />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollX>
        </div>
        {shown.length > 40 && (
          <button type="button" className="btn-ghost pw-more" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${shown.length}`}
          </button>
        )}
        <p className="pv-note">
          Rated = at least {5} innings, {60} balls faced and {3} dismissals (batting), or 8 overs in
          4 spells with a wicket (bowling). Rating is the percentile among players at the same age
          bracket, format and gender (50 = typical).
        </p>
      </Figure>
    </div>
  );
}

function PlayerList({
  lines,
  disc,
  watch,
  pick,
  empty,
}: {
  lines: BracketLine[];
  disc: Disc;
  watch: Watchlist;
  pick: (id: string) => void;
  empty: string;
}) {
  if (!lines.length) return <div className="pv-empty">{empty}</div>;
  return (
    <ul className="jn-list">
      {lines.map((l) => (
        <li key={l.player.id + l.bracket}>
          <button type="button" className="jn-name" onClick={() => pick(l.player.id)}>
            {l.player.name}
          </button>
          <span className="jn-sub">{l.bracket}</span>
          <span className="jn-gain">
            {disc === 'bat'
              ? `avg ${f1(average(l.t))} · SR ${f0(strikeRate(l.t))}`
              : `econ ${f2(economy(l.t))} · ${l.t.wkts} wkts`}
          </span>
          <WatchButton player={watchId(l.player)} watch={watch} compact />
        </li>
      ))}
    </ul>
  );
}

/** One player: the climb bracket by bracket, every innings, and the journey underneath. */
function PlayerDetail({
  player,
  bs,
  seasons,
  latest,
  format,
  watch,
  onClose,
}: {
  player: JourneyPlayer;
  bs: BracketBoard[];
  seasons: number[];
  latest: number;
  format: Format;
  watch: Watchlist;
  onClose: () => void;
}) {
  const j = journeyOf(player, latest);
  const lines = bs
    .flatMap((b) => b.lines)
    .filter((l) => l.player.id === player.id)
    .sort((a, b) => rungOf(a.bracket) - rungOf(b.bracket));
  const inns: InningsCol[] = [...player.rows]
    .filter((r) => r.format === format)
    .sort((a, b) => a.season - b.season || rungOf(a.bracket) - rungOf(b.bracket))
    .flatMap((r) => {
      const [lo, hi] = BANDS[r.bracket];
      return r.bat.map((i) => ({
        season: r.season,
        label: r.bracket,
        runs: i.r,
        balls: i.b,
        out: i.out,
        band: (i.r < lo ? 'bust' : i.r >= hi ? 'boom' : 'steady') as 'bust' | 'steady' | 'boom',
        tip: `${r.season} · ${r.bracket} · ${r.team} · ${i.r}${i.out ? '' : '*'} off ${i.b}`,
      }));
    });
  return (
    <div className="card jn-detail">
      <div className="card-head">
        <div>
          <div className="card-title">{player.name}</div>
          <div className="card-sub">
            <JourneySummary j={j} />
          </div>
        </div>
        <div className="jn-actions">
          <WatchButton player={watchId(player)} watch={watch} />
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="card-body">
        <JourneyStrip j={j} seasons={seasons} />
        <div className="tbl-w">
          <ScrollX label="Table">
            <table className="tbl sc-tbl pw-ladder" aria-label={`${player.name} by age bracket`}>
              <thead>
                <tr>
                  <th>Age group</th>
                  <th className="num">Seasons</th>
                  <th className="num">Games</th>
                  <th className="num">Balls faced</th>
                  <th className="num">Avg</th>
                  <th className="num">Median</th>
                  <th className="num">SR</th>
                  <th className="num">Overs</th>
                  <th className="num">Econ</th>
                  <th className="num">Wkts</th>
                  <th className="num">Bat rating</th>
                  <th className="num">Bowl rating</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.bracket}>
                    <td>
                      <strong>{l.bracket}</strong>
                    </td>
                    <td className="num">{l.seasons.length}</td>
                    <td className="num">{l.t.games}</td>
                    <td className="num">{l.t.balls}</td>
                    <td className="num">{f1(average(l.t))}</td>
                    <td className="num">{f0(medianScore(l.t))}</td>
                    <td className="num">{f0(strikeRate(l.t))}</td>
                    <td className="num">{l.t.bBalls ? overs(l.t.bBalls) : '–'}</td>
                    <td className="num">{f2(economy(l.t))}</td>
                    <td className="num">{l.t.bBalls ? l.t.wkts : '–'}</td>
                    <td className="num">{l.batPct ?? '–'}</td>
                    <td className="num">{l.bowlPct ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        </div>
        {inns.length > 0 && <InningsColumns cols={inns} />}
        <p className="pv-note">
          {format} only. Ratings are the percentile at that age bracket (50 = typical); a dash means
          too few balls to rate fairly.
        </p>
      </div>
    </div>
  );
}

function JourneySummary({ j }: { j: Journey }) {
  return (
    <>
      {j.school ? `From ${j.school}` : `First seen at ${j.firstTeam}`} · seen {j.first}–{j.last} ·
      reached {j.highest} · <Pill tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Pill>
      {j.reachedPro && <Pill tone="gold">Franchise</Pill>}
    </>
  );
}

/* ═══════════════════════ Route to professional ═══════════════════════ */

type Show = 'all' | 'active' | 'new' | 'exited' | 'pro';

export function RouteToPro() {
  const { js, seasons, first, latest } = useJourneyData();
  const { get, set } = useParam();
  const watch = useWatchlist();
  const [all, setAll] = useState(false);
  const gender: Gender = get('jg') === 'women' ? 'women' : 'men';
  const show = (['active', 'new', 'exited', 'pro'] as Show[]).find((s) => s === get('js')) ?? 'all';
  const schoolOf = get('jsc');
  const needle = get('jq').trim().toLowerCase();
  const mine = useMemo(() => js.filter((j) => j.player.gender === gender), [js, gender]);
  const flow = useMemo(() => flowBySeason(mine, seasons), [mine, seasons]);
  const fun = useMemo(() => funnel(js, gender, first), [js, gender, first]);
  const mix = useMemo(() => settingMix(js, gender), [js, gender]);
  const routes = useMemo(() => routesToPro(mine), [mine]);
  const origins = useMemo(() => schoolOrigins(mine), [mine]);
  // The step into the franchise is always narrow, so it isn't a leak; the others are compared.
  const worst = fun.reduce<number | null>(
    (a, r) =>
      r.share !== null && r.bracket !== 'Senior' && (a === null || r.share < a) ? r.share : a,
    null,
  );
  const rows = useMemo(
    () =>
      mine
        .filter(
          (j) =>
            (show === 'all' || (show === 'pro' ? j.reachedPro : j.status === show)) &&
            (!schoolOf || j.school === schoolOf) &&
            (!needle || j.player.name.toLowerCase().includes(needle)),
        )
        .sort(
          (a, b) =>
            Number(b.reachedPro) - Number(a.reachedPro) ||
            rungOf(b.highest) - rungOf(a.highest) ||
            b.last - a.last,
        ),
    [mine, show, schoolOf, needle],
  );
  const watched = watch.keys
    .map((k) => js.find((j) => watchKey(watchId(j.player)) === k))
    .filter((j): j is Journey => !!j);
  const pickId = get('jp');
  const picked = pickId ? js.find((j) => j.player.id === pickId) : undefined;
  const gaps = mine.filter((j) => j.gaps.length).length;
  const schools = [...new Set(js.flatMap((j) => (j.school ? [j.school] : [])))].sort();

  return (
    <div>
      <SampleNote />
      <div className="ml-bar" role="group" aria-label="Route filters">
        <Seg
          label="Gender"
          value={gender}
          options={[
            ['men', 'Boys & men'],
            ['women', 'Girls & women'],
          ]}
          onChange={(g) => set({ jg: g === 'men' ? null : g, jp: null })}
        />
        <Seg
          label="Status"
          value={show}
          options={[
            ['all', 'Everyone'],
            ['active', 'Active'],
            ['new', 'New'],
            ['exited', 'Left the data'],
            ['pro', 'Franchise'],
          ]}
          onChange={(s) => set({ js: s === 'all' ? null : s })}
        />
        <select
          className="field-select"
          aria-label="School"
          value={schoolOf}
          onChange={(e) => set({ jsc: e.target.value || null })}
          style={{ maxWidth: 190 }}
        >
          <option value="">Every school</option>
          {schools.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          className="field-input"
          type="search"
          placeholder="Find a player…"
          aria-label="Find a player"
          value={get('jq')}
          onChange={(e) => set({ jq: e.target.value || null })}
          style={{ maxWidth: 200 }}
        />
      </div>

      <div className="kpi-strip sc-kpis">
        <KPI label="In the data" num={mine.length} sub={`${first}–${latest}`} />
        <KPI
          label="Reached the franchise"
          num={mine.filter((j) => j.reachedPro).length}
          sub="at least one franchise game"
        />
        <KPI
          label={`Playing in ${latest}`}
          num={mine.filter((j) => j.status !== 'exited').length}
          sub={`${mine.filter((j) => j.status === 'new').length} first seen this season`}
        />
        <KPI
          label="Left the data"
          num={mine.filter((j) => j.status === 'exited').length}
          sub="last seen before this season"
        />
        <KPI label="With a gap" num={gaps} sub="a season missing between two they played" />
      </div>

      <Figure
        title="Watching"
        sub="Click the eye on any player below, or in Player scouting, to bring them here · school or club they came from, games in each setting, and the seasons they were seen"
      >
        {watched.length ? (
          <div className="jn-watch">
            {watched.map((j) => (
              <JourneyCard key={j.player.id} j={j} seasons={seasons} watch={watch} />
            ))}
          </div>
        ) : (
          <div className="pv-empty">
            Nobody yet. Use the eye in the table below to put a player on the watch list.
          </div>
        )}
      </Figure>

      <div className="pw-grid-2">
        <Figure
          title="Who comes in, who goes"
          sub="Players recorded each season, those first seen that season, and those last seen"
        >
          <FlowBars rows={flow} />
        </Figure>
        <Figure
          title="Where the pipeline leaks"
          sub="At each age bracket, how many players were also seen one bracket up · the biggest drop-off is marked"
        >
          <FunnelBars
            rows={fun.map((r) => ({
              key: r.bracket,
              label: r.bracket,
              ever: r.ever,
              onward: r.onward,
              leftHere: r.leftHere,
              joinedHere: r.joinedHere,
              share: r.share,
              leak: worst !== null && r.bracket !== 'Senior' && r.share === worst,
            }))}
          />
        </Figure>
      </div>

      <Figure
        title="School scene, club scene"
        sub="Where each age bracket's games are played · a player in two settings counts in both"
      >
        <SettingMixBars rows={mix.map((r) => ({ key: r.bracket, label: r.bracket, ...r }))} />
      </Figure>

      <div className="pw-grid-2">
        <Figure
          title="How the franchise players got there"
          sub="The order each player first appeared in school, club and franchise cricket, with the median seasons it took and games played before the first franchise game"
        >
          {routes.length ? (
            <div className="tbl-w">
              <ScrollX label="Routes to the franchise">
                <table className="tbl sc-tbl pw-ladder" aria-label="Routes to the franchise">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th className="num">Players</th>
                      <th className="num">Seasons</th>
                      <th className="num">Games before</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((r) => (
                      <tr key={r.route}>
                        <td>
                          <RouteChips steps={r.steps} />
                        </td>
                        <td className="num">{r.n}</td>
                        <td className="num">{f1(r.yearsToPro)}</td>
                        <td className="num">{f0(r.gamesBefore)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollX>
            </div>
          ) : (
            <div className="pv-empty">No franchise players in this group yet.</div>
          )}
        </Figure>
        <Figure
          title="Where players started"
          sub="The school each player was first seen at, how many went on to club cricket, and how many reached the franchise"
        >
          <div className="tbl-w">
            <ScrollX label="Where players started">
              <table className="tbl sc-tbl pw-ladder" aria-label="Where players started">
                <thead>
                  <tr>
                    <th>School</th>
                    <th className="num">Players</th>
                    <th className="num">Also club</th>
                    <th className="num">Franchise</th>
                  </tr>
                </thead>
                <tbody>
                  {origins.map((o) => (
                    <tr
                      key={o.team}
                      className="pick"
                      onClick={() => set({ jsc: schoolOf === o.team ? null : o.team })}
                    >
                      <td>
                        <strong>{o.team}</strong>
                      </td>
                      <td className="num">{o.players}</td>
                      <td className="num">{o.inClub}</td>
                      <td className="num">{o.reachedPro}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollX>
          </div>
        </Figure>
      </div>

      {picked && (
        <Figure title={picked.player.name} sub={<JourneySummary j={picked} />}>
          <JourneyStrip j={picked} seasons={seasons} />
          <button type="button" className="btn-ghost" onClick={() => set({ jp: null })}>
            Close
          </button>
        </Figure>
      )}

      <Figure
        title="Everyone in the system"
        sub={`${rows.length} player${rows.length === 1 ? '' : 's'} · franchise players first, then by how far up they got · tap a row for the season-by-season route`}
      >
        <div className="tbl-w">
          <ScrollX label="Players in the system">
            <table className="tbl sc-tbl pw-ladder jn-tbl" aria-label="Players in the system">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>From</th>
                  <th className="hide-narrow">Route</th>
                  <th>Seen</th>
                  <th className="num">School</th>
                  <th className="num">Club</th>
                  <th className="num hide-narrow">Rep</th>
                  <th className="num">Franchise</th>
                  <th>Highest</th>
                  <th>Status</th>
                  <th aria-label="Watch" />
                </tr>
              </thead>
              <tbody>
                {(all ? rows : rows.slice(0, 40)).map((j) => (
                  <tr
                    key={j.player.id}
                    className={`pick ${pickId === j.player.id ? 'on' : ''}`}
                    onClick={() => set({ jp: j.player.id })}
                  >
                    <td>
                      <strong>{j.player.name}</strong>
                    </td>
                    <td>{j.school ?? j.firstTeam}</td>
                    <td className="hide-narrow">
                      <RouteChips steps={j.route} />
                    </td>
                    <td>
                      {j.first}–{j.last}
                      {j.gaps.length > 0 && (
                        <span className="jn-gap" title={`No games in ${j.gaps.join(', ')}`}>
                          {' '}
                          gap
                        </span>
                      )}
                    </td>
                    <td className="num">{j.games.school || '–'}</td>
                    <td className="num">{j.games.club || '–'}</td>
                    <td className="num hide-narrow">{j.games.rep || '–'}</td>
                    <td className="num">{j.games.pro || '–'}</td>
                    <td>{j.highest}</td>
                    <td>
                      <Pill tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Pill>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <WatchButton player={watchId(j.player)} watch={watch} compact />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollX>
        </div>
        {rows.length > 40 && (
          <button type="button" className="btn-ghost pw-more" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        <p className="pv-note">
          Players are only recorded from {first}, so someone who started earlier is seen from
          partway up. &ldquo;Left the data&rdquo; means no games recorded since before {latest}: it
          may be they stopped, or moved to cricket that isn&apos;t recorded here. Location is not
          yet included.
        </p>
      </Figure>
    </div>
  );
}

function RouteChips({ steps }: { steps: Journey['route'] }) {
  return (
    <span className="jn-route">
      {steps.map((s, i) => (
        <span key={s}>
          {i > 0 && <em aria-hidden="true">→</em>}
          <span className={`jn-chip ${s}`}>{SETTING_LABEL[s]}</span>
        </span>
      ))}
    </span>
  );
}

function JourneyCard({ j, seasons, watch }: { j: Journey; seasons: number[]; watch: Watchlist }) {
  const g = j.games;
  return (
    <div className="jn-card">
      <div className="jn-card-head">
        <div>
          <strong>{j.player.name}</strong>
          <div className="jn-sub">
            {j.school ? `From ${j.school}` : `First seen at ${j.firstTeam}`} · {j.first}–{j.last} ·
            reached {j.highest}
          </div>
        </div>
        <WatchButton player={watchId(j.player)} watch={watch} />
      </div>
      <div className="jn-card-stats">
        {SETTINGS.map((s) => (
          <span key={s}>
            <b>{g[s]}</b>
            {SETTING_LABEL[s].toLowerCase()} games
          </span>
        ))}
        <Pill tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Pill>
        {j.gaps.length > 0 && <Pill tone="muted">Gap: {j.gaps.join(', ')}</Pill>}
      </div>
      <JourneyStrip j={j} seasons={seasons} compact />
    </div>
  );
}
