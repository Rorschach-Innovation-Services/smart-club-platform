/**
 * Professional-team scorecards: the "Scorecard CSV" export (one file per match — batting,
 * bowling and fall of wickets per innings) parsed into the scouting match shape, so the
 * scouting derivations (dismissals, partnerships, run sources) apply unchanged. Pure.
 *
 * The export has no ball-by-ball, so `perOver` is empty and `balls` absent: anything by phase
 * comes from the fall of wickets (the over each wicket fell), never from guessed deliveries.
 */
import type { ScoutBatRow, ScoutBowlRow, ScoutInnings, ScoutMatch } from './scouting-matches';

export type ProFormat = 'T20' | 'One-Day' | 'Multi-day';
export const PRO_FORMATS: ProFormat[] = ['T20', 'One-Day', 'Multi-day'];
export type Gender = 'men' | 'women';

export interface ProMatch extends ScoutMatch {
  format: ProFormat;
  gender: Gender;
  /** SA season, e.g. "2025/26" (August to July). */
  season: string;
  /** How the result was worked out from the totals; null when it can't be (rain, DLS). */
  resultKind: 'runs' | 'wickets' | 'innings' | 'tie' | 'draw' | 'unknown';
}

/** Minimal CSV reader for the export: quoted fields, commas inside quotes, CRLF. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const t = text.replace(/^\uFEFF/, '');
  while (i < t.length) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
    i++;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim()));
}

/**
 * The export's dismissal text in the scouting convention the helpers read:
 * "(c) X, (b) Y" → "c X b Y", "(lbw) Y" → "lbw b Y", "(run out) X, Z" → "run out (X+Z)",
 * "(st) X, (b) Y" → "st X b Y", "(c & b) Y" → "c & b Y", "hit wicket (b) Y" → "hit wicket b Y".
 */
export function normaliseHowOut(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^not out$/i.test(s)) return 'not out';
  if (/^retired not out$/i.test(s)) return 'retired not out';
  if (/^retired out$/i.test(s)) return 'retired out';
  let m = /^\(c & b\) (.+)$/i.exec(s);
  if (m) return `c & b ${m[1]}`;
  m = /^\((c|st)\) (.+?), \(b\) (.+)$/i.exec(s);
  if (m) return `${m[1].toLowerCase()} ${m[2]} b ${m[3]}`;
  m = /^\(b\) (.+)$/i.exec(s);
  if (m) return `b ${m[1]}`;
  m = /^\(lbw\) (.+)$/i.exec(s);
  if (m) return `lbw b ${m[1]}`;
  m = /^\(run out\) ?(.*)$/i.exec(s);
  if (m) {
    const who = m[1]
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    return who.length ? `run out (${who.join('+')})` : 'run out';
  }
  m = /^hit wicket \(b\) (.+)$/i.exec(s);
  if (m) return `hit wicket b ${m[1]}`;
  return s.toLowerCase();
}

const num = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const oversToBalls = (o: string) => {
  const [a, b] = String(o || '0').split('.');
  return num(a) * 6 + num(b);
};
const ballsToOvers = (b: number) => `${Math.floor(b / 6)}${b % 6 ? `.${b % 6}` : ''}`;

export const genderOf = (team: string): Gender =>
  /\b(ladies|women)\b/i.test(team) ? 'women' : 'men';

/** "WSB Western Province Women" → "Western Province", "DP World Lions" → "Lions". */
export function shortTeam(name: string) {
  const s = name.replace(/\b(ladies|women)\b/gi, '').trim();
  if (/western province$/i.test(s)) return 'Western Province';
  if (/eastern cape iinyathi$/i.test(s)) return 'Iinyathi';
  if (/garden route badgers$/i.test(s)) return 'Badgers';
  return s.split(/\s+/).slice(-1)[0] || s;
}

/** SA cricket season for a date: August–July, e.g. 2025-10-01 → "2025/26". */
export function seasonOf(date: string) {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 8 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Parse one scorecard CSV. Returns null for a file that isn't one (no MATCH INFO / innings).
 * `id` should be stable (the file name is fine).
 */
export function parseScorecard(text: string, id: string): ProMatch | null {
  const rows = csvRows(text);
  const date = rows.find((r) => r[0] === 'MATCH INFO')?.[2] ?? '';
  const vs = rows.findIndex((r) => r[0] === 'vs' && r.length <= 2);
  if (!date || vs < 1) return null;
  const home = rows[vs - 1][0];
  const away = rows[vs + 1][0];
  if (!home || !away) return null;

  // Innings blocks are in the order they were batted. The "1st/2nd innings" label marks the
  // side that batted first or second in the match, not the innings number, so it's ignored.
  const sameTeam = (t: string) =>
    t.toLowerCase() === home.toLowerCase()
      ? home
      : t.toLowerCase() === away.toLowerCase()
        ? away
        : t;
  const innings: ScoutInnings[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (!/^\d(st|nd|rd|th) innings$/i.test(r[1] ?? '')) {
      i++;
      continue;
    }
    const bat = sameTeam(r[0]);
    const inn: ScoutInnings = {
      bat,
      fld: bat === home ? away : home,
      total: 0,
      wkts: 0,
      overs: '0',
      extras: 0,
      exb: { w: 0, nb: 0, b: 0, lb: 0 },
      batting: [],
      bowling: [],
      fow: [],
      perOver: [],
    };
    i++;
    // Batting until TOTAL.
    while (i < rows.length && rows[i][0] !== 'Batter') i++;
    i++;
    let pos = 0;
    while (i < rows.length && rows[i][0] && rows[i][0] !== 'TOTAL') {
      const [n, how, R, B, f4, f6, , dots] = rows[i];
      const row: ScoutBatRow = {
        n,
        pos: ++pos,
        r: num(R),
        b: num(B),
        f4: num(f4),
        f6: num(f6),
        out: normaliseHowOut(how),
        dots: dots === undefined || dots === '' ? undefined : num(dots),
      };
      inn.batting.push(row);
      i++;
    }
    if (rows[i]?.[0] === 'TOTAL') {
      inn.total = num(rows[i][2]);
      i++;
    }
    if (rows[i]?.[0] === 'Extras') {
      const parts = Object.fromEntries(
        [...(rows[i][1] ?? '').matchAll(/(\d+)\s*(w|nb|b|lb|p)\b/g)].map((m) => [m[2], num(m[1])]),
      ) as Record<string, number>;
      inn.exb = { w: parts.w ?? 0, nb: parts.nb ?? 0, b: parts.b ?? 0, lb: parts.lb ?? 0 };
      inn.extras = num(rows[i][2]);
      i++;
    }
    // Bowling (the fielding side's block) until Total:.
    while (i < rows.length && rows[i][0] !== 'Bowler' && !/innings$/i.test(rows[i][1] ?? '')) i++;
    if (rows[i]?.[0] === 'Bowler') {
      i++;
      while (i < rows.length && rows[i][0] && rows[i][0] !== 'Total:') {
        const [n, O, M, R, W, , dots, WD, NB] = rows[i];
        const b: ScoutBowlRow = {
          n,
          o: O,
          m: num(M),
          r: num(R),
          w: num(W),
          wd: num(WD),
          nb: num(NB),
          dots: num(dots),
        };
        inn.bowling.push(b);
        i++;
      }
      if (rows[i]?.[0] === 'Total:') {
        inn.overs = rows[i][1] || '0';
        i++;
      }
    }
    // Fall of wickets (optional).
    while (
      i < rows.length &&
      rows[i][0] !== 'FALL OF WICKETS' &&
      !/innings$/i.test(rows[i][1] ?? '')
    )
      i++;
    if (rows[i]?.[0] === 'FALL OF WICKETS') {
      i += 2; // the header row "Batter","Score","Over"
      while (i < rows.length && rows[i][0] && /\d+\/\d+/.test(rows[i][1] ?? '')) {
        const [batter, score, over] = rows[i];
        const [s, w] = score.split('/').map(num);
        inn.fow.push({ wkt: w, score: s, batter, over });
        i++;
      }
    }
    inn.fow.sort((a, b) => a.wkt - b.wkt);
    inn.wkts =
      inn.fow.length ||
      inn.batting.filter((b) => b.out && !/^not out|^retired not/.test(b.out)).length;
    // Recompute the overs string from the bowlers when the Total: row is missing.
    if (inn.overs === '0' && inn.bowling.length)
      inn.overs = ballsToOvers(inn.bowling.reduce((n, b) => n + oversToBalls(b.o), 0));
    innings.push(inn);
  }
  if (!innings.length) return null;

  const maxBalls = Math.max(...innings.map((x) => oversToBalls(x.overs)));
  const format: ProFormat =
    innings.length > 2 || maxBalls > 50 * 6 ? 'Multi-day' : maxBalls > 20 * 6 ? 'One-Day' : 'T20';
  const overs = format === 'T20' ? 20 : format === 'One-Day' ? 50 : 0;
  const { winner, result, resultKind } = decide(innings, format, overs);
  return {
    id,
    date,
    event: format,
    stage: '',
    overs,
    venue: '',
    home,
    away,
    winner,
    result,
    innings,
    format,
    gender: genderOf(home) === 'women' || genderOf(away) === 'women' ? 'women' : 'men',
    season: seasonOf(date),
    resultKind,
  };
}

/**
 * The result from the totals. Limited overs: the chase either passed the target (won by
 * wickets) or was bowled out / ran out of overs (lost by runs); a chase that stopped short
 * with wickets and overs in hand was cut by weather, so it is left unknown rather than guessed.
 * Multi-day: an innings win, a fourth-innings chase or a draw.
 */
function decide(
  inns: ScoutInnings[],
  format: ProFormat,
  overs: number,
): Pick<ProMatch, 'winner' | 'result' | 'resultKind'> {
  const short = (t: string) => shortTeam(t);
  if (format !== 'Multi-day') {
    if (inns.length < 2) return { winner: null, result: 'No result', resultKind: 'unknown' };
    const [a, b] = inns;
    if (b.total > a.total)
      return {
        winner: b.bat,
        result: `${short(b.bat)} won by ${10 - b.wkts} wicket${10 - b.wkts === 1 ? '' : 's'}`,
        resultKind: 'wickets',
      };
    const chaseDone = b.wkts >= 10 || oversToBalls(b.overs) >= overs * 6;
    if (b.total === a.total && chaseDone)
      return { winner: null, result: 'Tied', resultKind: 'tie' };
    if (chaseDone)
      return {
        winner: a.bat,
        result: `${short(a.bat)} won by ${a.total - b.total} run${a.total - b.total === 1 ? '' : 's'}`,
        resultKind: 'runs',
      };
    return {
      winner: null,
      result: 'Result not on the scorecard (reduced or abandoned)',
      resultKind: 'unknown',
    };
  }
  const teamA = inns[0].bat;
  const sum = (team: string) => inns.filter((x) => x.bat === team).reduce((n, x) => n + x.total, 0);
  const teamB = inns.find((x) => x.bat !== teamA)?.bat;
  if (!teamB) return { winner: null, result: 'Draw', resultKind: 'draw' };
  if (inns.length === 3 && inns[1].bat === inns[2].bat && inns[2].wkts >= 10) {
    const twice = inns[1].bat;
    const once = twice === teamA ? teamB : teamA;
    if (sum(twice) < sum(once))
      return {
        winner: once,
        result: `${short(once)} won by an innings and ${sum(once) - sum(twice)} runs`,
        resultKind: 'innings',
      };
  }
  if (inns.length === 4) {
    const last = inns[3];
    const other = last.bat === teamA ? teamB : teamA;
    if (sum(last.bat) > sum(other))
      return {
        winner: last.bat,
        result: `${short(last.bat)} won by ${10 - last.wkts} wicket${10 - last.wkts === 1 ? '' : 's'}`,
        resultKind: 'wickets',
      };
    if (last.wkts >= 10 && sum(last.bat) < sum(other))
      return {
        winner: other,
        result: `${short(other)} won by ${sum(other) - sum(last.bat)} runs`,
        resultKind: 'runs',
      };
  }
  return { winner: null, result: 'Draw', resultKind: 'draw' };
}

/** Parse many files, dropping duplicates (the same match exported twice). */
export function parseScorecards(files: { name: string; text: string }[]): ProMatch[] {
  const seen = new Set<string>();
  const out: ProMatch[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const m = parseScorecard(f.text, f.name.replace(/\.csv$/i, ''));
    if (!m) continue;
    const key = `${m.date}|${m.home}|${m.away}|${m.innings!.map((x) => `${x.total}/${x.wkts}`).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
