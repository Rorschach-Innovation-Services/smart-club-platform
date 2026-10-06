/* ─── Professional team → one match in depth ───
 *
 * Built from what the records hold. With the ball by ball: the score after every over and at
 * every wicket, and the runs in each over. From the scorecard alone: the score at every wicket
 * (the worm runs straight between wickets — nothing is invented in between). Either way:
 * partnerships, how each batter used the balls they faced, every bowler's figures, the
 * standouts and the full scorecards.
 */
import { useState } from 'react';
import { partnerships } from './scouting';
import type { ScoutInnings } from './scouting-matches';
import { oversToBalls, shortTeam, type ProMatch } from './pro-scorecards';
import { isUs, type Baseline, type Squad } from './pro-team';
import type { ProFormat } from './pro-scorecards';
import {
  BallUseBars,
  barPath,
  Legend,
  PairBars,
  RankBars,
  Tile,
  shortName,
  useWidth,
  type Tone,
} from './pro-charts';

const r1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const ordinalInn = (n: number) => ['1st', '2nd', '3rd', '4th'][n] ?? `${n + 1}th`;

type WormPt = { over: number; runs: number; wkt: number | null; batter?: string };

/** With the deliveries: the score after every over and at every wicket. */
function wormFromBalls(inn: ScoutInnings): WormPt[] {
  const pts: WormPt[] = [{ over: 0, runs: 0, wkt: null }];
  let runs = 0;
  let legal = 0;
  let wkts = 0;
  let over = 0;
  for (const [o, , , , bat, extra, extraRuns, wicket] of inn.balls ?? []) {
    if (o !== over && legal) pts.push({ over: legal / 6, runs, wkt: null });
    over = o;
    runs += bat + extraRuns;
    if (extra !== 'wd' && extra !== 'nb') legal++;
    if (wicket) {
      wkts++;
      pts.push({ over: legal / 6, runs, wkt: wkts, batter: inn.fow[wkts - 1]?.batter });
    }
  }
  pts.push({ over: legal / 6, runs, wkt: null });
  return pts;
}

/** The score at each wicket and at the close, as (over, runs) points. */
function wormPoints(inn: ScoutInnings): WormPt[] {
  if (inn.balls?.length) return wormFromBalls(inn);
  const pts: WormPt[] = [{ over: 0, runs: 0, wkt: null }];
  inn.fow.forEach((f) =>
    pts.push({ over: oversToBalls(f.over) / 6, runs: f.score, wkt: f.wkt, batter: f.batter }),
  );
  const end = oversToBalls(inn.overs) / 6;
  if (end > (pts[pts.length - 1]?.over ?? 0) || inn.total > (pts[pts.length - 1]?.runs ?? 0))
    pts.push({ over: end, runs: inn.total, wkt: null });
  return pts;
}

function WicketWorm({ squad, innings }: { squad: Squad; innings: ScoutInnings[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const H = 280;
  const pad = { l: 42, r: 16, t: 14, b: 30 };
  const series = innings.map((inn, i) => ({
    inn,
    i,
    pts: wormPoints(inn),
    tone: (isUs(squad, inn.bat) ? 'squad' : 'context') as Tone,
  }));
  const maxO = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => p.over)));
  const maxR = Math.max(10, ...series.flatMap((s) => s.pts.map((p) => p.runs)));
  const sx = (o: number) => pad.l + (o / maxO) * (W - pad.l - pad.r);
  const sy = (r: number) => H - pad.b - (r / (maxR * 1.05)) * (H - pad.t - pad.b);
  const stepO = maxO <= 20 ? 5 : maxO <= 50 ? 10 : 20;
  const stepR = maxR <= 200 ? 50 : maxR <= 400 ? 100 : 200;
  // End labels: above each line's end, pushed apart when two innings finish close together.
  const labelY: Record<number, number> = {};
  [...series]
    .map((s) => ({ i: s.i, y: sy(s.pts[s.pts.length - 1].runs) - 6 }))
    .sort((a, b) => a.y - b.y)
    .forEach((l, k, all) => {
      const prev = k ? labelY[all[k - 1].i] : -Infinity;
      labelY[l.i] = Math.max(l.y, prev + 14, pad.t + 10);
    });
  return (
    <div className="pv-trend" ref={box}>
      <Legend
        items={series.map((s) => ({
          tone: s.tone,
          label: `${shortTeam(s.inn.bat)} ${ordinalInn(s.i)} inns`,
        }))}
      />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Score at each wicket, by over">
        {Array.from({ length: Math.floor(maxR / stepR) + 1 }, (_, k) => k * stepR).map((v) => (
          <g key={`r${v}`}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {Array.from({ length: Math.floor(maxO / stepO) + 1 }, (_, k) => k * stepO).map((v) => (
          <text key={`o${v}`} className="pv-tick" x={sx(v)} y={H - pad.b + 16} textAnchor="middle">
            {v}
          </text>
        ))}
        <text className="pv-axis" x={(pad.l + W - pad.r) / 2} y={H - 2} textAnchor="middle">
          Overs
        </text>
        {series.map((s) => (
          <g key={s.i}>
            <path
              className={`pv-tline ${s.tone}${s.i >= 2 ? ' dash' : ''}`}
              d={s.pts.map((p, k) => `${k ? 'L' : 'M'}${sx(p.over)},${sy(p.runs)}`).join('')}
            />
            {s.pts
              .filter((p) => p.wkt !== null)
              .map((p) => {
                const key = `${s.i}-${p.wkt}`;
                return (
                  <g
                    key={key}
                    onMouseEnter={() =>
                      setHover(
                        `${shortTeam(s.inn.bat)} ${p.runs}/${p.wkt} after ${r1(p.over)} overs — ${p.batter} out`,
                      )
                    }
                    onMouseLeave={() => setHover(null)}
                  >
                    <circle cx={sx(p.over)} cy={sy(p.runs)} r={10} fill="transparent" />
                    <circle className={`pv-dot ${s.tone}`} cx={sx(p.over)} cy={sy(p.runs)} r={4} />
                  </g>
                );
              })}
            {(() => {
              const last = s.pts[s.pts.length - 1];
              return (
                <text
                  className="pv-label"
                  x={Math.min(sx(last.over) + 6, W - pad.r - 40)}
                  y={labelY[s.i]}
                >
                  {last.runs}
                  {s.inn.wkts < 10 ? `/${s.inn.wkts}` : ''}
                </text>
              );
            })()}
          </g>
        ))}
      </svg>
      <div className="pv-bar-sub">
        {hover ??
          (innings.every((i) => i.balls?.length)
            ? 'Each dot is a wicket · the line is the score after every over'
            : 'Each dot is a wicket · the line runs straight between wickets (the scorecard records the score only when a wicket falls)')}
      </div>
    </div>
  );
}

function InningsCard({
  squad,
  inn,
  n,
  base,
}: {
  squad: Squad;
  inn: ScoutInnings;
  n: number;
  base: Baseline | null;
}) {
  const us = isUs(squad, inn.bat);
  const parts = partnerships(inn);
  const balls = oversToBalls(inn.overs);
  const fours = inn.batting.reduce((a, b) => a + b.f4, 0);
  const sixes = inn.batting.reduce((a, b) => a + b.f6, 0);
  const dots = inn.bowling.reduce((a, b) => a + b.dots, 0);
  return (
    <section
      className={`card pro-inn-card${us ? ' us' : ''}`}
      aria-label={`${shortTeam(inn.bat)} ${ordinalInn(n)} innings`}
    >
      <div className="card-head">
        <div>
          <div className="card-title">
            {shortTeam(inn.bat)} · {ordinalInn(n)} innings
          </div>
          <div className="card-sub">
            {inn.total}
            {inn.wkts < 10 ? `/${inn.wkts}` : ' all out'} in {inn.overs} overs · run rate{' '}
            {balls ? r1((inn.total / balls) * 6) : '–'}
            {base ? ` (format average ${r1(base.econ)})` : ''} · {fours} fours, {sixes} sixes ·{' '}
            {dots} dot balls ({balls ? Math.round((dots / balls) * 100) : 0}%) · extras {inn.extras}{' '}
            ({inn.exb.w}w {inn.exb.nb}nb)
          </div>
        </div>
      </div>
      <div className="card-body">
        <div className="sc-two pro-inn-two">
          <div>
            <div className="pro-mini-title">How each batter used the balls they faced</div>
            <BallUseBars
              rows={inn.batting
                .filter((b) => b.b > 0)
                .map((b) => ({
                  id: b.n,
                  label: shortName(b.n),
                  balls: b.b,
                  dots: b.dots ?? null,
                  fours: b.f4,
                  sixes: b.f6,
                  runs: b.r,
                }))}
            />
          </div>
          <div>
            <div className="pro-mini-title">Partnerships</div>
            <RankBars
              rows={parts.map((p) => ({
                id: String(p.wkt),
                label: `${p.wkt}${['st', 'nd', 'rd'][p.wkt - 1] ?? 'th'} wkt${p.unbroken ? ' *' : ''}`,
                value: p.runs,
                tone: (us ? 'squad' : 'context') as Tone,
                text: `${p.runs}`,
              }))}
            />
          </div>
        </div>
        <div className="pro-mini-title">
          {shortTeam(inn.fld)} bowling: economy (wickets in the label)
        </div>
        <RankBars
          rows={inn.bowling.map((b) => {
            const bb = oversToBalls(b.o);
            const e = bb ? (b.r / bb) * 6 : 0;
            return {
              id: b.n,
              label: `${shortName(b.n)} · ${b.w}/${b.r}`,
              value: e,
              tone: (us ? 'context' : 'squad') as Tone,
              text: `${r1(e)} · ${b.o} ov · ${b.dots} dots${b.wd + b.nb ? ` · ${b.wd}w ${b.nb}nb` : ''}`,
            };
          })}
          refValue={base?.econ}
          refLabel="format avg"
        />
        <details className="pro-card-details">
          <summary>Scorecard</summary>
          <table className="pro-mini-tbl">
            <tbody>
              {inn.batting.map((b) => (
                <tr key={b.n}>
                  <td>{b.n}</td>
                  <td className="ump-sub">{b.out}</td>
                  <td>
                    {b.r} ({b.b})
                  </td>
                  <td className="ump-sub">
                    {b.f4}×4 {b.f6}×6
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="pro-mini-tbl">
            <tbody>
              {inn.bowling.map((b) => (
                <tr key={b.n}>
                  <td>{b.n}</td>
                  <td>
                    {b.o}-{b.m}-{b.r}-{b.w}
                  </td>
                  <td className="ump-sub">{b.dots} dots</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ump-sub">
            Fall of wickets:{' '}
            {inn.fow.map((f) => `${f.score}/${f.wkt} (${f.batter}, ${f.over})`).join(' · ') || '—'}
          </p>
        </details>
      </div>
    </section>
  );
}

/** Runs in each over, innings side by side; a mark over the bar for each wicket. */
function RunsPerOver({ squad, innings }: { squad: Squad; innings: ScoutInnings[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [box, W] = useWidth(640);
  const H = 220;
  const pad = { l: 34, r: 10, t: 16, b: 30 };
  const series = innings.map((inn, i) => ({
    inn,
    i,
    tone: (isUs(squad, inn.bat) ? 'squad' : 'context') as Tone,
  }));
  const overs = Math.max(1, ...innings.flatMap((i) => i.perOver.map(([o]) => o)));
  const maxR = Math.max(6, ...innings.flatMap((i) => i.perOver.map(([, r]) => r)));
  const slot = (W - pad.l - pad.r) / overs;
  const gap = Math.min(2, slot * 0.15);
  const bw = Math.max(1, (slot - gap * (series.length + 1)) / series.length);
  const sy = (r: number) => H - pad.b - (r / (maxR * 1.1)) * (H - pad.t - pad.b);
  const step = maxR <= 12 ? 4 : maxR <= 24 ? 6 : 10;
  const oStep = overs <= 20 ? 5 : 10;
  return (
    <div className="pv-trend" ref={box}>
      <Legend
        items={series.map((s) => ({ tone: s.tone, label: `${shortTeam(s.inn.bat)} innings` }))}
      />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Runs in each over">
        {Array.from({ length: Math.floor(maxR / step) + 1 }, (_, k) => k * step).map((v) => (
          <g key={`r${v}`}>
            <line className="pv-grid" x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} />
            <text className="pv-tick" x={pad.l - 6} y={sy(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {Array.from({ length: Math.floor(overs / oStep) }, (_, k) => (k + 1) * oStep).map((o) => (
          <text
            key={`o${o}`}
            className="pv-tick"
            x={pad.l + (o - 0.5) * slot}
            y={H - pad.b + 16}
            textAnchor="middle"
          >
            {o}
          </text>
        ))}
        <text className="pv-axis" x={(pad.l + W - pad.r) / 2} y={H - 2} textAnchor="middle">
          Over
        </text>
        {series.flatMap((s) =>
          s.inn.perOver.map(([o, r, w]) => {
            const x = pad.l + (o - 1) * slot + gap + s.i * (bw + gap);
            const y = sy(r);
            const tip = `${shortTeam(s.inn.bat)}, over ${o}: ${r} run${r === 1 ? '' : 's'}${w ? `, ${w} wicket${w === 1 ? '' : 's'}` : ''}`;
            return (
              <g
                key={`${s.i}-${o}`}
                onMouseEnter={() => setHover(tip)}
                onMouseLeave={() => setHover(null)}
              >
                <rect
                  x={x - gap / 2}
                  y={pad.t}
                  width={bw + gap}
                  height={H - pad.b - pad.t}
                  fill="transparent"
                />
                <path className={`pv-fill ${s.tone}`} d={barPath(x, y, bw, H - pad.b - y, 'up')} />
                {Array.from({ length: w }, (_, k) => (
                  <circle
                    key={k}
                    className={`pv-dot ${s.tone}`}
                    cx={x + bw / 2}
                    cy={y - 5 - k * 7}
                    r={Math.max(2.5, Math.min(4, bw / 2))}
                  />
                ))}
              </g>
            );
          }),
        )}
      </svg>
      <div className="pv-bar-sub">{hover ?? 'Each dot above a bar is a wicket in that over'}</div>
    </div>
  );
}

export function ProMatchView({
  squad,
  match: m,
  bases,
  onBack,
  openPlayer,
}: {
  squad: Squad;
  match: ProMatch;
  bases: Record<ProFormat, Baseline | null>;
  onBack: () => void;
  openPlayer: (name: string) => void;
}) {
  const inns = m.innings ?? [];
  const opp = shortTeam(isUs(squad, m.home) ? m.away : m.home);
  const ours = inns.filter((i) => isUs(squad, i.bat));
  const theirs = inns.filter((i) => !isUs(squad, i.bat));
  const outcome =
    m.resultKind === 'draw'
      ? 'Drawn'
      : !m.winner
        ? 'No result on the scorecard'
        : isUs(squad, m.winner)
          ? 'Won'
          : 'Lost';
  const sumBy = (xs: ScoutInnings[], f: (i: ScoutInnings) => number) =>
    xs.reduce((a, i) => a + f(i), 0);
  const balls = (xs: ScoutInnings[]) => sumBy(xs, (i) => oversToBalls(i.overs));
  const rate = (xs: ScoutInnings[]) =>
    balls(xs) ? (sumBy(xs, (i) => i.total) / balls(xs)) * 6 : 0;
  const dotsBowled = (xs: ScoutInnings[]) =>
    balls(xs) ? (sumBy(xs, (i) => i.bowling.reduce((a, b) => a + b.dots, 0)) / balls(xs)) * 100 : 0;
  const bnd = (xs: ScoutInnings[]) =>
    sumBy(xs, (i) => i.batting.reduce((a, b) => a + b.f4 + b.f6, 0));
  // Standouts: best innings and spells on each side.
  const bats = inns.flatMap((i) => i.batting.map((b) => ({ ...b, team: i.bat })));
  const spells = inns.flatMap((i) => i.bowling.map((b) => ({ ...b, team: i.fld })));
  const topBat = (us: boolean) =>
    bats.filter((b) => isUs(squad, b.team) === us).sort((a, b) => b.r - a.r)[0];
  const topBowl = (us: boolean) =>
    spells.filter((b) => isUs(squad, b.team) === us).sort((a, b) => b.w - a.w || a.r - b.r)[0];
  const base = bases[m.format];
  return (
    <div className="pro-dive pro-match">
      <button type="button" className="pro-link" onClick={onBack}>
        ← All matches
      </button>
      <div
        className={`pro-match-head ${outcome === 'Won' ? 'won' : outcome === 'Lost' ? 'lost' : ''}`}
      >
        <div className="sc-panel-eyebrow">
          {fmtDay(m.date)} · {m.format} · {m.season}
        </div>
        <h2 className="pro-dive-name">
          {shortTeam(squad.name)} v {opp}
        </h2>
        <div className="pro-match-scores">
          {inns.map((i, k) => (
            <span key={k} className={isUs(squad, i.bat) ? 'us' : ''}>
              {shortTeam(i.bat)} {i.total}
              {i.wkts < 10 ? `/${i.wkts}` : ''} <small>({i.overs})</small>
            </span>
          ))}
        </div>
        <div className="pro-match-result">
          <span className={`pv-res ${outcome === 'Won' ? 'W' : outcome === 'Lost' ? 'L' : 'D'}`}>
            {outcome[0]}
          </span>{' '}
          {m.result}
        </div>
      </div>

      <div className="pv-tiles">
        <Tile
          label="Run rate"
          value={r1(rate(ours))}
          sub={`${opp} ${r1(rate(theirs))}`}
          tone={rate(ours) >= rate(theirs) ? 'good' : 'bad'}
        />
        <Tile
          label="Dot balls bowled"
          value={`${Math.round(dotsBowled(theirs))}%`}
          sub={`${opp} ${Math.round(dotsBowled(ours))}%`}
          tone={dotsBowled(theirs) >= dotsBowled(ours) ? 'good' : 'bad'}
        />
        <Tile
          label="Boundaries"
          value={bnd(ours)}
          sub={`${opp} ${bnd(theirs)}`}
          tone={bnd(ours) >= bnd(theirs) ? 'good' : 'bad'}
        />
        <Tile
          label="Extras conceded"
          value={sumBy(theirs, (i) => i.extras)}
          sub={`${opp} gave ${sumBy(ours, (i) => i.extras)}`}
          tone={sumBy(theirs, (i) => i.extras) <= sumBy(ours, (i) => i.extras) ? 'good' : 'bad'}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">How the game unfolded</div>
            <div className="card-sub">
              {inns.length && inns.every((i) => i.balls?.length)
                ? 'Score after every over and at each wicket'
                : 'Score at every wicket, by over'}{' '}
              · navy {shortTeam(squad.name)}, grey {opp}
              {inns.length > 2 ? ' · dashed = second innings' : ''}
            </div>
          </div>
        </div>
        <div className="card-body">
          <WicketWorm squad={squad} innings={inns} />
        </div>
      </div>

      {m.format !== 'Multi-day' && inns.length > 0 && inns.every((i) => i.perOver.length) && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Runs in each over</div>
              <div className="card-sub">
                From the ball by ball · navy {shortTeam(squad.name)}, grey {opp}
              </div>
            </div>
          </div>
          <div className="card-body">
            <RunsPerOver squad={squad} innings={inns} />
          </div>
        </div>
      )}

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Standouts</div>
              <div className="card-sub">
                Top score and best spell on each side · tap ours for their details
              </div>
            </div>
          </div>
          <div className="card-body pro-standouts">
            {[true, false].map((us) => {
              const b = topBat(us);
              const w = topBowl(us);
              return (
                <div key={String(us)} className={us ? 'us' : ''}>
                  <div className="pro-mini-title">{us ? shortTeam(squad.name) : opp}</div>
                  {b && (
                    <button
                      type="button"
                      className="pro-standout"
                      disabled={!us}
                      onClick={() => openPlayer(b.n)}
                    >
                      <strong>
                        {b.r}
                        {/^not out|^retired not/.test(b.out) ? '*' : ''}
                      </strong>{' '}
                      <span>
                        {b.n} · {b.b} balls · {b.f4}×4 {b.f6}×6
                      </span>
                    </button>
                  )}
                  {w && (
                    <button
                      type="button"
                      className="pro-standout"
                      disabled={!us}
                      onClick={() => openPlayer(w.n)}
                    >
                      <strong>
                        {w.w}/{w.r}
                      </strong>{' '}
                      <span>
                        {w.n} · {w.o} overs · {w.dots} dots
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Side by side</div>
              <div className="card-sub">
                {shortTeam(squad.name)} v {opp}, every innings together
              </div>
            </div>
          </div>
          <div className="card-body">
            <PairBars
              ours={shortTeam(squad.name)}
              theirs={opp}
              rows={[
                {
                  label: 'Runs',
                  ours: sumBy(ours, (i) => i.total),
                  theirs: sumBy(theirs, (i) => i.total),
                },
                { label: 'Run rate', ours: rate(ours), theirs: rate(theirs) },
                {
                  label: 'Wickets lost',
                  ours: sumBy(ours, (i) => i.wkts),
                  theirs: sumBy(theirs, (i) => i.wkts),
                },
                {
                  label: 'Fours',
                  ours: sumBy(ours, (i) => i.batting.reduce((a, b) => a + b.f4, 0)),
                  theirs: sumBy(theirs, (i) => i.batting.reduce((a, b) => a + b.f4, 0)),
                },
                {
                  label: 'Sixes',
                  ours: sumBy(ours, (i) => i.batting.reduce((a, b) => a + b.f6, 0)),
                  theirs: sumBy(theirs, (i) => i.batting.reduce((a, b) => a + b.f6, 0)),
                },
                { label: 'Dot balls bowled %', ours: dotsBowled(theirs), theirs: dotsBowled(ours) },
              ]}
            />
          </div>
        </div>
      </div>

      {inns.map((inn, k) => (
        <InningsCard key={k} squad={squad} inn={inn} n={k} base={base} />
      ))}
      <p className="pv-note">
        From the scorecard export: batting, bowling and fall of wickets. With ball-by-ball
        (Medicoach Live) this page would add runs per over, phases, shot zones and spells over by
        over.
      </p>
    </div>
  );
}
