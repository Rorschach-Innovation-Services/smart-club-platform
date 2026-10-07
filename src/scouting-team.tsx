/* ─── Scouting: team (hub) detail ─── */

import { useState } from 'react';
import { Btn, KPI } from './atoms';
import type { ScoutPlayer, ScoutingEvent } from './scouting-data';
import type { ScoutInnings, ScoutMatch } from './scouting-matches';
import {
  leaderboard,
  oversOf,
  roleOf,
  phaseSplit,
  teamInnings,
  worm,
  shotsOf,
  hasBallData,
  runSources,
  dismissalCounts,
  DISMISSAL_KINDS,
  runsByPosition,
  partnershipByWicket,
  bowlingUsage,
} from './scouting';
import {
  WagonWheel,
  FormStrip,
  InningsShapes,
  HBars,
  PairBars,
  ShareBar,
  Columns,
} from './scouting-charts';
import { WatchButton } from './scouting-player';
import type { Watchlist } from './scouting-player';

const fmtShort = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Average run rate per phase across this team's recorded innings — batting and bowling. */
function phaseRates(event: ScoutingEvent, code: string) {
  const acc = {
    bat: new Map<string, [number, number]>(),
    bowl: new Map<string, [number, number]>(),
  };
  event.matches.forEach((m) =>
    m.innings?.forEach((inn) => {
      const side = inn.bat === code ? 'bat' : inn.fld === code ? 'bowl' : null;
      if (!side) return;
      phaseSplit(inn, m.overs).forEach((p) => {
        const [r, o] = acc[side].get(p.key) ?? [0, 0];
        acc[side].set(p.key, [r + p.runs, o + p.overs]);
      });
    }),
  );
  return ['Powerplay', 'Middle', 'Death'].map((k) => {
    const [br, bo] = acc.bat.get(k) ?? [0, 0];
    const [wr, wo] = acc.bowl.get(k) ?? [0, 0];
    return { key: k, bat: bo ? br / bo : null, bowl: wo ? wr / wo : null };
  });
}

function Bars({
  rows,
  openPlayer,
}: {
  rows: { player: ScoutPlayer; value: number; label: string }[];
  openPlayer: (p: ScoutPlayer) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="sc-bars">
      {rows.map((r, i) => (
        <li key={r.player.name}>
          <button type="button" className="sc-bar-row" onClick={() => openPlayer(r.player)}>
            <span className="sc-bar-rank">{i + 1}</span>
            <span className="sc-bar-name">{r.player.name}</span>
            <span className="sc-bar-track">
              <span className="sc-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="sc-bar-val">{r.label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function TeamDetail({
  event,
  code,
  watch,
  onBack,
  openPlayer,
  openMatch,
}: {
  event: ScoutingEvent;
  code: string;
  watch: Watchlist;
  onBack: () => void;
  openPlayer: (p: ScoutPlayer) => void;
  openMatch: (m: ScoutMatch) => void;
}) {
  const t = event.teams.find((x) => x.code === code);
  if (!t)
    return (
      <div>
        <Btn tone="ghost" size="sm" onClick={onBack}>
          ← Back
        </Btn>
        <div className="ss-empty">Team not found.</div>
      </div>
    );
  const squad = event.players
    .filter((p) => p.hub === code)
    .sort((a, b) => (b.runs ?? 0) + 20 * (b.wkts ?? 0) - ((a.runs ?? 0) + 20 * (a.wkts ?? 0)));
  const matches = event.matches
    .filter((m) => m.home === code || m.away === code)
    .sort((a, b) => a.date.localeCompare(b.date));
  const scoreFor = (m: ScoutMatch, side: string) => {
    const s = (m.innings ?? m.summary ?? []).find((i) => i.bat === side);
    return s ? `${s.total}/${s.wkts} (${s.overs})` : '—';
  };
  const runs = leaderboard(squad, 'runs', '', 6).map((r) => ({ ...r, label: String(r.value) }));
  const wkts = leaderboard(squad, 'wkts', '', 6).map((r) => ({ ...r, label: String(r.value) }));
  const phases = phaseRates(event, code);

  // Graph inputs — all from the recorded scorecards (and ball-by-ball where present).
  const { bat, bowl } = teamInnings(event, code);
  const batInns = bat.map((x) => x.inn);
  const bowlInns = bowl.map((x) => x.inn);
  const scored = runSources(batInns);
  const conceded = runSources(bowlInns);
  const lost = dismissalCounts(batInns);
  const taken = dismissalCounts(bowlInns);
  const positions = runsByPosition(batInns).filter((p) => p.inns > 0);
  const stands = partnershipByWicket(batInns).filter((p) => p.n > 0);
  const usage = bowlingUsage(bowlInns).slice(0, 8);
  const balls = hasBallData([...batInns, ...bowlInns]);

  return (
    <div className="mx">
      <Btn tone="ghost" size="sm" onClick={onBack}>
        ← All teams
      </Btn>
      <div className="mx-mast">
        <div className="mx-eyebrow">
          Team profile · {t.code} · {event.name}
        </div>
        <h2 className="mx-result">{t.name}</h2>
        <div className="mx-sub">{t.placing}</div>
      </div>

      <div className="kpi-strip sc-kpis">
        <KPI label="Won–lost" num={`${t.won}–${t.lost}`} sub={`${t.played} played`} tone="teal" />
        <KPI label="Runs scored" num={t.runsScored} sub={`${t.runRate.toFixed(2)} per over`} />
        <KPI
          label="Runs conceded"
          num={t.runsConceded}
          sub={`${t.concededRate.toFixed(2)} per over`}
        />
        <KPI label="Wickets taken" num={t.wickets} sub={`${t.extrasConceded} extras conceded`} />
        {t.fiftyOver && (
          <KPI
            label="50-Over table"
            num={`${t.fiftyOver.pos}${['st', 'nd', 'rd'][t.fiftyOver.pos - 1] ?? 'th'}`}
            sub={`${t.fiftyOver.pts} pts · NRR ${t.fiftyOver.nrr}`}
          />
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Form & innings shapes</div>
            <div className="card-sub">
              Results in order · each line is one {t.code} batting innings (green = won)
            </div>
          </div>
        </div>
        <div className="card-body tf-stack">
          <FormStrip
            items={matches.map((m) => ({
              key: m.id,
              won: m.winner ? m.winner === code : null,
              label: `${m.home === code ? 'v' : '@'} ${m.home === code ? m.away : m.home}`,
              sub: `${fmtShort(m.date)} · ${m.result}`,
              onClick: () => openMatch(m),
            }))}
          />
          {bat.length ? (
            <InningsShapes
              series={bat.map(({ match, inn }) => ({
                key: match.id,
                label: inn.fld,
                won: match.winner ? match.winner === code : null,
                points: worm(inn).map((p) => [p.over, p.total] as [number, number]),
              }))}
            />
          ) : (
            <div className="sc-wl-none">No recorded innings.</div>
          )}
        </div>
      </div>

      <div className="sc-two">
        <TeamWheel event={event} code={code} batInns={batInns} bowlInns={bowlInns} balls={balls} />
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">How the runs come</div>
              <div className="card-sub">
                Scored by {t.code} v conceded by {t.code}
              </div>
            </div>
          </div>
          <div className="card-body tf-stack">
            <ShareBar
              label={`Scored · ${scored.total}`}
              parts={[
                { k: 'Boundaries', v: scored.boundaries, cls: 'i1' },
                { k: 'Running', v: scored.running, cls: 'soft' },
                { k: 'Extras', v: scored.extras, cls: 'i2' },
                ...(scored.unattributed
                  ? [{ k: 'Unattributed', v: scored.unattributed, cls: 'muted' }]
                  : []),
              ]}
            />
            <ShareBar
              label={`Conceded · ${conceded.total}`}
              parts={[
                { k: 'Boundaries', v: conceded.boundaries, cls: 'i1' },
                { k: 'Running', v: conceded.running, cls: 'soft' },
                { k: 'Extras', v: conceded.extras, cls: 'i2' },
                ...(conceded.unattributed
                  ? [{ k: 'Unattributed', v: conceded.unattributed, cls: 'muted' }]
                  : []),
              ]}
            />
          </div>
        </div>
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">How wickets fell</div>
              <div className="card-sub">
                Dismissal types · {t.code} batting v {t.code} bowling
              </div>
            </div>
          </div>
          <div className="card-body">
            <PairBars
              a="Wickets lost"
              b="Wickets taken"
              rows={DISMISSAL_KINDS.filter((k) => lost[k] || taken[k]).map((k) => ({
                key: k,
                label: k,
                a: lost[k],
                b: taken[k],
              }))}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Scoring by phase</div>
              <div className="card-sub">Runs per over · powerplay first 30%, death last 20%</div>
            </div>
          </div>
          <div className="card-body">
            <PairBars
              a="Batting"
              b="Conceded"
              format={(v) => v.toFixed(2)}
              rows={phases.map((p) => ({ key: p.key, label: p.key, a: p.bat, b: p.bowl }))}
            />
          </div>
        </div>
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Runs by batting position</div>
              <div className="card-sub">Total across {bat.length} recorded innings</div>
            </div>
          </div>
          <div className="card-body">
            <Columns
              cols={positions.map((p) => ({
                key: String(p.pos),
                label: String(p.pos),
                value: p.runs,
                title: `No. ${p.pos}: ${p.runs} runs in ${p.inns} innings`,
              }))}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Partnerships by wicket</div>
              <div className="card-sub">Average stand · best in the tooltip</div>
            </div>
          </div>
          <div className="card-body">
            <Columns
              format={(v) => v.toFixed(0)}
              cols={stands.map((p) => ({
                key: String(p.wkt),
                label: String(p.wkt),
                value: p.avg,
                title: `Wicket ${p.wkt}: average ${p.avg.toFixed(1)} over ${p.n}, best ${p.best}`,
              }))}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Bowling usage</div>
            <div className="card-sub">
              Who bowls the overs · economy and dot-ball share · {t.discipline.wides} wides,{' '}
              {t.discipline.noBalls} no-balls ({t.discipline.extrasPer10} extras per 10 overs)
            </div>
          </div>
        </div>
        <div className="card-body">
          <HBars
            format={(v) => `${Math.floor(v / 6)}${v % 6 ? `.${v % 6}` : ''} ov`}
            rows={usage.map((u) => ({
              key: u.n,
              label: u.n,
              value: u.balls,
              note: ` · ${u.wkts} wkt · econ ${u.econ.toFixed(2)} · ${u.dotPct.toFixed(0)}% dots`,
            }))}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Matches</div>
            <div className="card-sub">Tap a match for its dashboard</div>
          </div>
        </div>
        <div className="sc-scroll">
          <table className="sc-tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th>Event</th>
                <th>Stage</th>
                <th>Opponent</th>
                <th>Scored</th>
                <th>Conceded</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m) => {
                const opp = m.home === code ? m.away : m.home;
                const won = m.winner === code;
                return (
                  <tr key={m.id} className="clickable" onClick={() => openMatch(m)}>
                    <td className="nowrap">{fmtShort(m.date)}</td>
                    <td>{m.event}</td>
                    <td>{m.stage}</td>
                    <td>
                      <strong>v {opp}</strong>
                    </td>
                    <td className="nowrap">{scoreFor(m, code)}</td>
                    <td className="nowrap">{scoreFor(m, opp)}</td>
                    <td className={`nowrap ${m.winner ? (won ? 'won' : 'lost') : ''}`}>
                      {m.winner ? (won ? 'Won' : 'Lost') : m.result}
                      {m.winner && (
                        <span className="sc-how"> · {m.result.replace(/^\w+ won /, '')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="sc-two">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Leading run-scorers</div>
            </div>
          </div>
          <Bars rows={runs} openPlayer={openPlayer} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Leading wicket-takers</div>
            </div>
          </div>
          <Bars rows={wkts} openPlayer={openPlayer} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Squad</div>
            <div className="card-sub">{squad.length} players · tap a player for their profile</div>
          </div>
        </div>
        <div className="sc-scroll">
          <table className="sc-tbl sc-register">
            <thead>
              <tr>
                <th>Player</th>
                <th>Role</th>
                <th className="num">M</th>
                <th className="num">Runs</th>
                <th className="num">SR</th>
                <th className="num">Overs</th>
                <th className="num">Wkts</th>
                <th className="num">Econ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {squad.map((p) => (
                <tr key={p.name} className="clickable" onClick={() => openPlayer(p)}>
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td className="sc-how">{roleOf(p)}</td>
                  <td className="num">{p.m}</td>
                  <td className="num">{p.runs ?? '–'}</td>
                  <td className="num">{p.sr ?? '–'}</td>
                  <td className="num">{oversOf(p.ballsBowled)}</td>
                  <td className="num">{p.wkts ?? '–'}</td>
                  <td className="num">{p.econ?.toFixed(2) ?? '–'}</td>
                  <td className="num">
                    <WatchButton player={p} watch={watch} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Team scoring zones — batting, or where their bowlers conceded — filterable by player. */
function TeamWheel({
  event,
  code,
  batInns,
  bowlInns,
  balls,
}: {
  event: ScoutingEvent;
  code: string;
  batInns: ScoutInnings[];
  bowlInns: ScoutInnings[];
  balls: boolean;
}) {
  const [side, setSide] = useState<'bat' | 'bowl'>('bat');
  const [who, setWho] = useState('');
  const inns = side === 'bat' ? batInns : bowlInns;
  const names = [
    ...new Set(
      inns.flatMap((i) => (side === 'bat' ? i.batting.map((r) => r.n) : i.bowling.map((r) => r.n))),
    ),
  ];
  const shots = shotsOf(
    inns,
    side === 'bat' ? { batter: who || undefined } : { bowler: who || undefined },
  );
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Wagon wheel</div>
          <div className="card-sub">
            {side === 'bat' ? `Where ${code} score` : `Where ${code}'s bowling went`}
            {who ? ` · ${who}` : ''}
          </div>
        </div>
      </div>
      {balls && (
        <div className="tf-wheel-filters">
          <div className="season-toggle" role="group" aria-label="Batting or bowling">
            {(
              [
                ['bat', 'Batting'],
                ['bowl', 'Bowling'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                className={side === k ? 'on' : ''}
                aria-pressed={side === k}
                onClick={() => {
                  setSide(k);
                  setWho('');
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <select
            className="field-select sc-select"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            aria-label={side === 'bat' ? 'Batter' : 'Bowler'}
          >
            <option value="">{side === 'bat' ? 'All batters' : 'All bowlers'}</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="card-body">
        <WagonWheel
          shots={shots}
          empty={
            <>
              <strong>Shot zones aren't in the {event.name} scorecard export.</strong> Load the
              Medicoach Live ball-by-ball export (it records a zone for every scoring shot) and the
              wagon wheel fills in automatically.
            </>
          }
        />
      </div>
    </div>
  );
}
