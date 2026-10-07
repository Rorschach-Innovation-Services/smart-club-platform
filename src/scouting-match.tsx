/* ─── Scouting: per-fixture match dashboard ─── */

import { useState } from 'react';
import { Icon, Btn } from './atoms';
import type { ScoutPlayer, ScoutingEvent } from './scouting-data';
import type { ScoutInnings, ScoutMatch } from './scouting-matches';
import {
  teamName,
  phaseSplit,
  partnerships,
  worm,
  innStats,
  dotPct,
  isOut,
  ballsFromOvers,
  bowlerOf,
  shotsOf,
} from './scouting';
import { WagonWheel } from './scouting-charts';
import { WatchButton } from './scouting-player';
import type { Watchlist } from './scouting-player';

const fmtLong = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/* Innings colours: first innings in brand green, second in ink — always shown with a legend. */
const INN_CLASS = ['i1', 'i2'];

function Legend({ match }: { match: ScoutMatch }) {
  return (
    <div className="mx-legend">
      {match.innings!.map((inn, i) => (
        <span key={inn.bat}>
          <i className={`mx-key ${INN_CLASS[i]}`} />
          {inn.bat}
        </span>
      ))}
    </div>
  );
}

function WormChart({ match }: { match: ScoutMatch }) {
  const [hover, setHover] = useState<{ i: number; over: number; total: number } | null>(null);
  const W = 560;
  const H = 260;
  const pad = { l: 40, r: 56, t: 12, b: 32 };
  const series = match.innings!.map(worm);
  const maxOver = Math.max(...series.map((s) => s[s.length - 1]?.over ?? 0), 1);
  const maxRuns = Math.max(...match.innings!.map((i) => i.total), 10);
  const yMax = Math.ceil(maxRuns / 20) * 20;
  const sx = (o: number) => pad.l + (o / maxOver) * (W - pad.l - pad.r);
  const sy = (r: number) => H - pad.b - (r / yMax) * (H - pad.t - pad.b);
  const xTicks = Array.from({ length: 6 }, (_, k) => Math.round((maxOver * k) / 5));
  const yTicks = Array.from({ length: 5 }, (_, k) => (yMax * k) / 4);
  return (
    <div className="sc-scatter">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative runs by over">
        {yTicks.map((v) => (
          <g key={v}>
            <line className="sc-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="sc-tick" x={pad.l - 8} y={sy(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {[...new Set(xTicks)].map((v) => (
          <text key={v} className="sc-tick" x={sx(v)} y={H - pad.b + 16} textAnchor="middle">
            {v}
          </text>
        ))}
        <text className="sc-axis" x={(pad.l + W - pad.r) / 2} y={H - 4} textAnchor="middle">
          Overs
        </text>
        {series.map((s, i) => {
          const pts = [{ over: 0, total: 0, wkts: 0 }, ...s];
          const last = pts[pts.length - 1];
          return (
            <g key={i} className={`mx-line ${INN_CLASS[i]}`}>
              <polyline
                fill="none"
                points={pts.map((p) => `${sx(p.over)},${sy(p.total)}`).join(' ')}
              />
              {s
                .filter((p) => p.wkts > 0)
                .map((p) => (
                  <circle
                    key={p.over}
                    className="mx-wkt"
                    cx={sx(p.over)}
                    cy={sy(p.total)}
                    r={4.5}
                  />
                ))}
              {s.map((p) => (
                <circle
                  key={`h${p.over}`}
                  cx={sx(p.over)}
                  cy={sy(p.total)}
                  r={9}
                  fill="transparent"
                  onMouseEnter={() => setHover({ i, over: p.over, total: p.total })}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
              <text className="mx-end" x={sx(last.over) + 8} y={sy(last.total) + 4}>
                {match.innings![i].bat} {match.innings![i].total}
              </text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className="sc-tip"
          style={{ left: `${(sx(hover.over) / W) * 100}%`, top: `${(sy(hover.total) / H) * 100}%` }}
        >
          <strong>{match.innings![hover.i].bat}</strong>
          <span>
            After over {hover.over}: {hover.total}
          </span>
        </div>
      )}
    </div>
  );
}

function Manhattan({ match }: { match: ScoutMatch }) {
  const inns = match.innings!;
  const maxOver = Math.max(...inns.map((i) => i.perOver.length), 1);
  const maxRuns = Math.max(...inns.flatMap((i) => i.perOver.map(([, r]) => r)), 4);
  const W = 560;
  const H = 200;
  const pad = { l: 30, r: 8, t: 10, b: 28 };
  const slot = (W - pad.l - pad.r) / maxOver;
  const bw = Math.max(2, Math.min(10, slot / 2 - 2));
  const sy = (r: number) => H - pad.b - (r / maxRuns) * (H - pad.t - pad.b);
  return (
    <div className="sc-scatter">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Runs per over">
        {[0, Math.round(maxRuns / 2), maxRuns].map((v) => (
          <g key={v}>
            <line className="sc-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="sc-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {inns.map((inn, i) =>
          inn.perOver.map(([o, r, w]) => {
            const x = pad.l + (o - 1) * slot + slot / 2 + (i === 0 ? -bw - 1 : 1);
            return (
              <g key={`${i}-${o}`}>
                <rect
                  className={`mx-bar ${INN_CLASS[i]}`}
                  x={x}
                  y={sy(r)}
                  width={bw}
                  height={Math.max(0, sy(0) - sy(r))}
                  rx={2}
                >
                  <title>
                    {inn.bat} · over {o}: {r} run{r === 1 ? '' : 's'}
                    {w ? `, ${w} wicket${w > 1 ? 's' : ''}` : ''}
                  </title>
                </rect>
                {w > 0 && <circle className="mx-wkt" cx={x + bw / 2} cy={sy(r) - 6} r={3} />}
              </g>
            );
          }),
        )}
        {Array.from({ length: maxOver }, (_, k) => k + 1)
          .filter((o) => o === 1 || o % 5 === 0)
          .map((o) => (
            <text
              key={o}
              className="sc-tick"
              x={pad.l + (o - 1) * slot + slot / 2}
              y={H - pad.b + 16}
              textAnchor="middle"
            >
              {o}
            </text>
          ))}
      </svg>
    </div>
  );
}

/** Home side first, away second — as in the club match review. Colours follow batting order. */
function HeadToHead({ match }: { match: ScoutMatch }) {
  const inns = match.innings!;
  const a = inns.find((x) => x.bat === match.home);
  const b = inns.find((x) => x.bat === match.away);
  if (!a || !b) return null;
  const ca = INN_CLASS[inns.indexOf(a)];
  const cb = INN_CLASS[inns.indexOf(b)];
  const sa = innStats(a);
  const sb = innStats(b);
  const best = (inn: ScoutInnings) => Math.max(0, ...partnerships(inn).map((p) => p.runs));
  const rows: [string, number, number, (v: number) => string][] = [
    ['Run rate', sa.rr, sb.rr, (v) => v.toFixed(2)],
    ['Fours', sa.fours, sb.fours, String],
    ['Sixes', sa.sixes, sb.sixes, String],
    ['Extras received', a.extras, b.extras, String],
    ['Best partnership', best(a), best(b), String],
    // dot% of the side *bowling* — so attribute each innings' dots to its fielding side
    ['Dot balls bowled', dotPct(b), dotPct(a), (v) => `${v.toFixed(0)}%`],
  ];
  return (
    <div className="mx-h2h">
      <div className="mx-h2h-head">
        <span>{match.home}</span>
        <span />
        <span>{match.away}</span>
      </div>
      {rows.map(([label, va, vb, f]) => {
        const max = Math.max(va, vb) || 1;
        return (
          <div key={label} className="mx-h2h-row">
            <div className="mx-h2h-side left">
              <strong>{f(va)}</strong>
              <span className="sc-bar-track">
                <span className={`sc-bar-fill ${ca}`} style={{ width: `${(va / max) * 100}%` }} />
              </span>
            </div>
            <span className="mx-h2h-label">{label}</span>
            <div className="mx-h2h-side">
              <span className="sc-bar-track">
                <span className={`sc-bar-fill ${cb}`} style={{ width: `${(vb / max) * 100}%` }} />
              </span>
              <strong>{f(vb)}</strong>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlayerName({
  event,
  name,
  hub,
  openPlayer,
}: {
  event: ScoutingEvent;
  name: string;
  hub: string;
  openPlayer: (p: ScoutPlayer) => void;
}) {
  const p = event.players.find((x) => x.name === name && x.hub === hub);
  if (!p) return <>{name}</>;
  return (
    <button
      type="button"
      className="sc-link strong"
      onClick={(e) => {
        e.stopPropagation();
        openPlayer(p);
      }}
    >
      {name}
    </button>
  );
}

const sr = (r: number, b: number) => (b ? ((r / b) * 100).toFixed(0) : '–');
const econ = (r: number, o: string) => {
  const balls = ballsFromOvers(o);
  return balls ? ((r * 6) / balls).toFixed(2) : '–';
};

/* ── Batting (home side, or the scouted side) ── */

function BattingTable({
  event,
  inn,
  watch,
  openPlayer,
  title,
  sub,
}: {
  event: ScoutingEvent;
  inn: ScoutInnings;
  watch: Watchlist;
  openPlayer: (p: ScoutPlayer) => void;
  title: string;
  sub: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const picked = inn.batting.find((r) => r.n === sel) ?? null;
  // The scorer's total occasionally exceeds batting + extras (runs not credited to anyone).
  const unattributed = inn.total - inn.extras - inn.batting.reduce((n, r) => n + r.r, 0);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">{sub}</div>
        </div>
      </div>
      <div className="sc-scroll">
        <table className="sc-tbl mx-pick">
          <thead>
            <tr>
              <th>Batter</th>
              <th className="mx-how-col">How out</th>
              <th className="num">R</th>
              <th className="num">B</th>
              <th className="num">4s</th>
              <th className="num">6s</th>
              <th className="num">SR</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {inn.batting.map((r) => (
              <tr
                key={r.n}
                className="pick"
                aria-selected={sel === r.n}
                onClick={() => setSel(sel === r.n ? null : r.n)}
              >
                <td>
                  <span className="mx-name">{r.n}</span>
                  <span className="mx-how-sub">{r.out || 'not out'}</span>
                </td>
                <td className="sc-how mx-how-col">{r.out || 'not out'}</td>
                <td className="num">
                  <strong>
                    {r.r}
                    {isOut(r) ? '' : '*'}
                  </strong>
                </td>
                <td className="num">{r.b}</td>
                <td className="num">{r.f4}</td>
                <td className="num">{r.f6}</td>
                <td className="num">{sr(r.r, r.b)}</td>
                <td className="num">
                  <WatchButton player={{ name: r.n, hub: inn.bat }} watch={watch} compact />
                </td>
              </tr>
            ))}
            <tr className="mx-total">
              <td>Extras</td>
              <td className="sc-how mx-how-col">
                w {inn.exb.w}, nb {inn.exb.nb}, b {inn.exb.b}, lb {inn.exb.lb}
              </td>
              <td className="num">{inn.extras}</td>
              <td colSpan={5} />
            </tr>
            {unattributed > 0 && (
              <tr className="mx-total">
                <td>Unattributed</td>
                <td className="sc-how mx-how-col">
                  Scored but not credited to a batter in the source
                </td>
                <td className="num">{unattributed}</td>
                <td colSpan={5} />
              </tr>
            )}
            <tr className="mx-total">
              <td>
                <strong>Total</strong>
              </td>
              <td className="sc-how mx-how-col">{inn.overs} overs</td>
              <td className="num">
                <strong>
                  {inn.total}/{inn.wkts}
                </strong>
              </td>
              <td colSpan={5} />
            </tr>
          </tbody>
        </table>
      </div>
      {picked ? (
        <div className="mx-detail">
          <div className="mx-detail-head">
            <PlayerName event={event} name={picked.n} hub={inn.bat} openPlayer={openPlayer} />
            <span className="sc-how">
              No. {picked.pos} · {picked.out || 'not out'}
            </span>
          </div>
          <div className="sc-stats">
            <div className="sc-stat">
              <span>Runs (balls)</span>
              <strong>
                {picked.r}
                {isOut(picked) ? '' : '*'} ({picked.b})
              </strong>
            </div>
            <div className="sc-stat">
              <span>Strike rate</span>
              <strong>{sr(picked.r, picked.b)}</strong>
            </div>
            <div className="sc-stat">
              <span>Boundary runs</span>
              <strong>
                {picked.f4 * 4 + picked.f6 * 6}
                <em className="mx-of"> of {picked.r}</em>
              </strong>
            </div>
            <div className="sc-stat">
              <span>Share of total</span>
              <strong>{inn.total ? Math.round((picked.r / inn.total) * 100) : 0}%</strong>
            </div>
          </div>
          {inn.balls?.length ? (
            <div className="mx-wheel">
              <WagonWheel title="Scoring zones" shots={shotsOf([inn], { batter: picked.n })} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mx-detail-hint">Select a batter to see how they built the innings.</div>
      )}
    </div>
  );
}

function PartnershipsCard({ inn }: { inn: ScoutInnings }) {
  const parts = partnerships(inn);
  const maxP = Math.max(1, ...parts.map((p) => p.runs));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Partnerships</div>
          <div className="card-sub">By wicket · runs include extras</div>
        </div>
      </div>
      <div className="mx-parts">
        {parts.map((p) => (
          <div key={p.wkt} className="mx-part">
            <span className="mx-part-w">{p.wkt}</span>
            <span className="sc-bar-track">
              <span className="sc-bar-fill" style={{ width: `${(p.runs / maxP) * 100}%` }} />
            </span>
            <strong>
              {p.runs}
              {p.unbroken ? '*' : ''}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Bowling (home side, or the scouted side) ── */

function BowlingTable({
  event,
  inn,
  watch,
  openPlayer,
  title,
  sub,
}: {
  event: ScoutingEvent;
  inn: ScoutInnings;
  watch: Watchlist;
  openPlayer: (p: ScoutPlayer) => void;
  title: string;
  sub: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const picked = inn.bowling.find((r) => r.n === sel) ?? null;
  const teamEcon = (inn.total * 6) / Math.max(1, ballsFromOvers(inn.overs));
  const victims = picked ? inn.batting.filter((r) => isOut(r) && bowlerOf(r.out) === picked.n) : [];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">{sub}</div>
        </div>
      </div>
      <div className="sc-scroll">
        <table className="sc-tbl mx-pick">
          <thead>
            <tr>
              <th>Bowler</th>
              <th className="num">O</th>
              <th className="num">M</th>
              <th className="num">R</th>
              <th className="num">W</th>
              <th className="num">Econ</th>
              <th className="num">Dots</th>
              <th className="num">Wd</th>
              <th className="num">Nb</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {inn.bowling.map((r) => (
              <tr
                key={r.n}
                className="pick"
                aria-selected={sel === r.n}
                onClick={() => setSel(sel === r.n ? null : r.n)}
              >
                <td>
                  <span className="mx-name">{r.n}</span>
                </td>
                <td className="num">{r.o}</td>
                <td className="num">{r.m}</td>
                <td className="num">{r.r}</td>
                <td className="num">
                  <strong>{r.w}</strong>
                </td>
                <td className="num">{econ(r.r, r.o)}</td>
                <td className="num">{r.dots}</td>
                <td className={`num ${r.wd >= 5 ? 'mx-hot' : ''}`}>{r.wd}</td>
                <td className="num">{r.nb}</td>
                <td className="num">
                  <WatchButton player={{ name: r.n, hub: inn.fld }} watch={watch} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {picked ? (
        <div className="mx-detail">
          <div className="mx-detail-head">
            <PlayerName event={event} name={picked.n} hub={inn.fld} openPlayer={openPlayer} />
            <span className="sc-how">
              {picked.o} overs · {picked.w}/{picked.r}
            </span>
          </div>
          <div className="sc-stats">
            <div className="sc-stat">
              <span>Economy</span>
              <strong>
                {econ(picked.r, picked.o)}
                <em className="mx-of"> team {teamEcon.toFixed(2)}</em>
              </strong>
            </div>
            <div className="sc-stat">
              <span>Dot balls</span>
              <strong>
                {Math.round((picked.dots / Math.max(1, ballsFromOvers(picked.o))) * 100)}%
              </strong>
            </div>
            <div className="sc-stat">
              <span>Wides / no-balls</span>
              <strong>
                {picked.wd} / {picked.nb}
              </strong>
            </div>
          </div>
          <div className="sc-panel-sec">Wickets</div>
          {victims.length !== picked.w && (
            <p className="sc-note">
              The scorecard credits {picked.w} wicket{picked.w === 1 ? '' : 's'}, but{' '}
              {victims.length} dismissal{victims.length === 1 ? ' names' : 's name'} this bowler in
              the source data.
            </p>
          )}
          {victims.length ? (
            <div className="mx-victims">
              {victims.map((v) => (
                <div key={v.n} className="mx-victim">
                  <span>
                    {v.n} <em>No. {v.pos}</em>
                  </span>
                  <span className="sc-how">{v.out}</span>
                  <strong>{v.r}</strong>
                </div>
              ))}
            </div>
          ) : (
            <div className="sc-wl-none">No wickets in this spell.</div>
          )}
          {inn.balls?.length ? (
            <div className="mx-wheel">
              <WagonWheel
                title="Where the runs went"
                shots={shotsOf([inn], { bowler: picked.n })}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mx-detail-hint">
          Select a bowler to see their spell, control and who they dismissed.
        </div>
      )}
    </div>
  );
}

function ExtrasCard({ inn, title }: { inn: ScoutInnings; title: string }) {
  const parts: [string, number][] = [
    ['Wides', inn.exb.w],
    ['No-balls', inn.exb.nb],
    ['Byes', inn.exb.b],
    ['Leg-byes', inn.exb.lb],
  ];
  const max = Math.max(1, ...parts.map(([, v]) => v));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">
            {inn.extras} extras · {inn.total ? Math.round((inn.extras / inn.total) * 100) : 0}% of
            the runs
          </div>
        </div>
      </div>
      <div className="mx-parts">
        {parts.map(([k, v]) => (
          <div key={k} className="mx-part wide">
            <span className="mx-part-w">{k}</span>
            <span className="sc-bar-track">
              <span className="sc-bar-fill muted-ink" style={{ width: `${(v / max) * 100}%` }} />
            </span>
            <strong>{v}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function FallOfWickets({ inn }: { inn: ScoutInnings }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Fall of wickets</div>
          <div className="card-sub">{inn.bat} innings</div>
        </div>
      </div>
      {inn.fow.length ? (
        <div className="mx-fow-list">
          {inn.fow.map((f) => (
            <div key={f.wkt} className="mx-fow-row">
              <span className="mx-part-w">{f.wkt}</span>
              <strong>{f.score}</strong>
              <span>{f.batter}</span>
              <span className="sc-how">over {f.over}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="ss-empty">No wickets fell.</div>
      )}
    </div>
  );
}

/** How a side's runs came: boundaries, running between the wickets, extras. */
function RunSources({ inn }: { inn: ScoutInnings }) {
  const boundary = inn.batting.reduce((n, r) => n + r.f4 * 4 + r.f6 * 6, 0);
  const offBat = inn.batting.reduce((n, r) => n + r.r, 0);
  const running = Math.max(0, offBat - boundary);
  const other = Math.max(0, inn.total - offBat - inn.extras);
  const parts = [
    { k: 'Boundaries', v: boundary, c: 'i1' },
    { k: 'Running', v: running, c: 'soft' },
    { k: 'Extras', v: inn.extras, c: 'i2' },
    ...(other ? [{ k: 'Unattributed', v: other, c: 'muted' }] : []),
  ];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">How their runs came</div>
          <div className="card-sub">All {inn.total} runs</div>
        </div>
      </div>
      <div className="card-body">
        <div className="mx-dist" role="img" aria-label="Share of runs by source">
          {parts
            .filter((p) => p.v > 0)
            .map((p) => (
              <span key={p.k} className={p.c} style={{ flex: p.v }} title={`${p.k}: ${p.v}`} />
            ))}
        </div>
        <div className="mx-dist-legend">
          {parts.map((p) => (
            <span key={p.k}>
              <i className={`mx-key ${p.c}`} />
              {p.k} <strong>{p.v}</strong>{' '}
              <em>{inn.total ? Math.round((p.v / inn.total) * 100) : 0}%</em>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Dashboard ── */

type MTab = 'flow' | 'bowl' | 'bat' | 'scout';

export function MatchDashboard({
  event,
  match,
  watch,
  onBack,
  openPlayer,
}: {
  event: ScoutingEvent;
  match: ScoutMatch;
  watch: Watchlist;
  onBack: () => void;
  openPlayer: (p: ScoutPlayer) => void;
}) {
  const [tab, setTab] = useState<MTab>('flow');
  const sides = match.innings
    ? match.innings.map((i) => ({ bat: i.bat, total: i.total, wkts: i.wkts, overs: i.overs }))
    : (match.summary ?? []);
  const home = match.home;
  const away = match.away;
  const homeBat = match.innings?.find((i) => i.bat === home);
  const awayBat = match.innings?.find((i) => i.bat === away);
  const homeFirst = match.innings?.[0]?.bat === home;
  const homeName = teamName(event, home);
  const awayName = teamName(event, away);

  // One-line narrative per panel, worked out from the scorecard.
  const bowlLede =
    awayBat &&
    `${homeName} ${awayBat.wkts === 10 ? 'bowled' : 'held'} ${awayName} ${awayBat.wkts === 10 ? 'out for' : 'to'} ${awayBat.total}${awayBat.wkts === 10 ? '' : `/${awayBat.wkts}`} in ${awayBat.overs} overs, conceding ${awayBat.exb.w} wides.`;
  const target = awayBat ? awayBat.total + 1 : null;
  const batLede = !homeBat
    ? ''
    : homeFirst
      ? `Set ${homeBat.total}/${homeBat.wkts} in ${homeBat.overs} overs.`
      : match.winner === home
        ? `Chased ${target} in ${homeBat.overs} overs, finishing on ${homeBat.total}/${homeBat.wkts}.`
        : `Chasing ${target}, reached ${homeBat.total}/${homeBat.wkts} in ${homeBat.overs} overs.`;

  const TABS: [MTab, string][] = [
    ['flow', 'Match flow'],
    ['bowl', `${home} bowling`],
    ['bat', `${home} batting`],
    ['scout', `Scouting ${away}`],
  ];

  return (
    <div className="mx">
      <Btn tone="ghost" size="sm" onClick={onBack}>
        ← Back
      </Btn>
      <div className="mx-mast">
        <div className="mx-eyebrow">
          {event.name} · {match.event} · {match.stage} · {match.venue} · {fmtLong(match.date)}
        </div>
        <h2 className="mx-result">
          {match.winner ? `${teamName(event, match.winner)} won` : match.result}
          {match.winner && <span> {match.result.replace(/^\w+ won /, '')}</span>}
        </h2>
        <div className="mx-sub">
          Home <strong>{homeName}</strong> · Away <strong>{awayName}</strong>
        </div>
        <div className="mx-board">
          {(sides.length ? sides : [{ bat: home }, { bat: away }]).map((s, i) => (
            <div key={s.bat} className={`mx-side ${s.bat === match.winner ? 'win' : ''}`}>
              <div className="mx-team">
                <strong>{teamName(event, s.bat)}</strong>
                <span>
                  {s.bat === home ? 'Home' : 'Away'} · {i === 0 ? 'batted first' : 'chasing'}
                </span>
              </div>
              <div className="mx-score">
                {'total' in s && s.total != null ? `${s.total}/${s.wkts}` : '—'}
              </div>
              <div className="mx-meta">
                {'overs' in s && s.overs
                  ? `${s.overs} of ${match.overs} overs`
                  : 'No score recorded'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {!match.innings ? (
        <div className="card">
          <div className="ss-empty">
            <Icon.Alert /> The ball-by-ball scorecard for this match isn't in the source data — only
            the result above was recorded.
          </div>
        </div>
      ) : (
        <>
          <div className="sc-tabs mx-tabs" role="tablist" aria-label="Match review">
            {TABS.map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={tab === k ? 'on' : ''}
                onClick={() => setTab(k)}
              >
                {l}
              </button>
            ))}
          </div>

          {tab === 'flow' && (
            <div className="sc-body">
              <div className="mx-panel-head">
                <h3>How the match unfolded</h3>
                <p>Cumulative runs over by over. Dots mark wickets.</p>
              </div>
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Run progression</div>
                  </div>
                  <Legend match={match} />
                </div>
                <div className="card-body">
                  <WormChart match={match} />
                </div>
              </div>
              <div className="sc-two">
                <div className="card">
                  <div className="card-head">
                    <div>
                      <div className="card-title">Runs per over</div>
                      <div className="card-sub">Each pair of bars is one over, extras included</div>
                    </div>
                    <Legend match={match} />
                  </div>
                  <div className="card-body">
                    <Manhattan match={match} />
                  </div>
                </div>
                <div className="card">
                  <div className="card-head">
                    <div>
                      <div className="card-title">By phase</div>
                      <div className="card-sub">
                        Powerplay first 30% of {match.overs} overs · death last 20%
                      </div>
                    </div>
                  </div>
                  <div className="sc-scroll">
                    <table className="sc-tbl">
                      <thead>
                        <tr>
                          <th>Team</th>
                          <th>Phase</th>
                          <th className="num">Overs</th>
                          <th className="num">Runs</th>
                          <th className="num">RR</th>
                          <th className="num">Wkts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {match.innings.flatMap((inn) =>
                          phaseSplit(inn, match.overs).map((p, k) => (
                            <tr key={`${inn.bat}${p.key}`}>
                              <td>{k === 0 ? <strong>{inn.bat}</strong> : ''}</td>
                              <td>
                                {p.key}{' '}
                                <span className="sc-how">
                                  ({p.from}–{p.to})
                                </span>
                              </td>
                              <td className="num">{p.overs || '–'}</td>
                              <td className="num">{p.overs ? p.runs : '–'}</td>
                              <td className="num">{p.rr != null ? p.rr.toFixed(2) : '–'}</td>
                              <td className="num">{p.overs ? p.wkts : '–'}</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Head to head</div>
                    <div className="card-sub">
                      {home} (home) first, {away} (away) second
                    </div>
                  </div>
                </div>
                <div className="card-body">
                  <HeadToHead match={match} />
                </div>
              </div>
            </div>
          )}

          {tab === 'bowl' && awayBat && (
            <div className="sc-body">
              <div className="mx-panel-head">
                <h3>{homeName} bowling and fielding</h3>
                <p>{bowlLede} Select a bowler to see their spell.</p>
              </div>
              <BowlingTable
                event={event}
                inn={awayBat}
                watch={watch}
                openPlayer={openPlayer}
                title={`${home} bowling`}
                sub={`to ${awayName}`}
              />
              <div className="sc-two">
                <ExtrasCard inn={awayBat} title={`Extras ${home} conceded`} />
                <FallOfWickets inn={awayBat} />
              </div>
            </div>
          )}

          {tab === 'bat' && homeBat && (
            <div className="sc-body">
              <div className="mx-panel-head">
                <h3>{homeName} batting</h3>
                <p>{batLede} Select a batter to see how they built the innings.</p>
              </div>
              <BattingTable
                event={event}
                inn={homeBat}
                watch={watch}
                openPlayer={openPlayer}
                title={`${home} batting`}
                sub={`${homeBat.total}/${homeBat.wkts} (${homeBat.overs} ov)`}
              />
              <PartnershipsCard inn={homeBat} />
            </div>
          )}

          {tab === 'scout' && awayBat && homeBat && (
            <div className="sc-body">
              <div className="mx-panel-head">
                <h3>Scouting {awayName}</h3>
                <p>
                  Who scored for them, which of their bowlers held {home} back, and where their runs
                  came from.
                </p>
              </div>
              <BattingTable
                event={event}
                inn={awayBat}
                watch={watch}
                openPlayer={openPlayer}
                title="Their batting"
                sub={`${awayBat.total}/${awayBat.wkts} (${awayBat.overs} ov) · select a batter`}
              />
              <BowlingTable
                event={event}
                inn={homeBat}
                watch={watch}
                openPlayer={openPlayer}
                title="Their bowling"
                sub="Dot balls and wides say most about who controlled the innings"
              />
              {awayBat.balls?.length ? (
                <div className="sc-two">
                  <RunSources inn={awayBat} />
                  <div className="card">
                    <div className="card-head">
                      <div>
                        <div className="card-title">Their team scoring zones</div>
                        <div className="card-sub">Every scoring shot by zone</div>
                      </div>
                    </div>
                    <div className="card-body">
                      <WagonWheel shots={shotsOf([awayBat])} />
                    </div>
                  </div>
                </div>
              ) : (
                <RunSources inn={awayBat} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
