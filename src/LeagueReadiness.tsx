/**
 * The admin Leagues page's season column: one status per league, what it is waiting on,
 * and the one thing to do next (see `league-readiness.ts` for the rules).
 *
 * Authority is the operator's: a league that needs setup gets a copyable request to send
 * them, never a control that edits the setup here.
 */
import { Btn, Pill } from './atoms';
import { formatIsoDate } from '../packages/engine/src/calendar';
import {
  readinessCounts,
  readinessSummaryParts,
  STATUS_LABEL,
  type LeagueReadiness,
  type LeagueReadinessStatus,
} from './league-readiness';

type Toast = (message: string, tone?: string) => void;

const STATUS_TONE: Record<LeagueReadinessStatus, string> = {
  ready: 'teal',
  running: 'gold',
  'needs-setup': 'coral',
  'needs-sides': 'navy',
};

/** "3 ready to start · 2 need operator setup · 1 needs sides · 4 running" (zeros left out). */
export function ReadinessSummary({ list }: { list: LeagueReadiness[] }) {
  const parts = readinessSummaryParts(readinessCounts(list));
  if (!parts.length) return null;
  return (
    <div className="lr-summary" aria-label="Season readiness">
      {parts.map((p) => (
        <span key={p.status} className={`lr-sum lr-sum-${p.status}`}>
          <strong>{p.count}</strong> {p.text}
        </span>
      ))}
    </div>
  );
}

/** "T20 League · 20 overs on 2026/27 (12 Sep 2026 → 27 Mar 2027)", or what is missing. */
function setupLine(r: LeagueReadiness): string {
  if (!r.setup) return 'Not set up';
  const structure = r.setup.structureLabel ?? 'structure missing';
  const calendar = r.setup.calendarLabel ?? 'calendar missing';
  const dates =
    r.setup.start && r.setup.end
      ? ` (${formatIsoDate(r.setup.start)} → ${formatIsoDate(r.setup.end)})`
      : '';
  return `${structure} on ${calendar}${dates}${r.calendarEnded ? ' — ended' : ''}`;
}

/** Copy the operator request, saying whether it worked. */
async function copyRequest(text: string, toast?: Toast) {
  try {
    await navigator.clipboard.writeText(text);
    toast?.('Request copied — send it to your operator');
  } catch {
    toast?.('Could not copy — select the request and copy it yourself', 'warn');
  }
}

export function LeagueSeasonCell({
  readiness: r,
  onStart,
  onOpenSeason,
  onOpenClub,
  toast,
}: {
  readiness: LeagueReadiness;
  /** Opens Start a season with this league preselected. Absent ⇒ no Start button. */
  onStart?: () => void;
  onOpenSeason?: (runId: string) => void;
  onOpenClub?: (clubId: string) => void;
  toast?: Toast;
}) {
  const label = r.league.label;
  return (
    <div className="lr-cell">
      <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
      <dl className="lr-facts">
        <dt>Setup</dt>
        <dd>{setupLine(r)}</dd>
        <dt>Sides</dt>
        <dd>
          {r.sides.registered} registered, {r.sides.affiliated} affiliated
        </dd>
        {r.run && (
          <>
            <dt>{r.run.running ? 'Season' : 'Last season'}</dt>
            <dd>
              {r.run.seasonLabel} · {r.run.progress}
              {r.run.running && r.run.stages.length > 1 && (
                <ul className="lr-stages">
                  {r.run.stages.map((s) => (
                    <li key={s.line}>{s.line}</li>
                  ))}
                </ul>
              )}
            </dd>
          </>
        )}
      </dl>
      <p className="lr-next">{r.nextStep}</p>

      {r.status === 'needs-setup' && r.operatorRequest && (
        <div className="lr-request">
          <span className="lr-request-text">{r.operatorRequest}</span>
          <Btn
            tone="outline"
            size="sm"
            aria-label={`Copy request for ${label}`}
            onClick={() => void copyRequest(r.operatorRequest!, toast)}
          >
            Copy request
          </Btn>
        </div>
      )}

      {r.status === 'needs-sides' && r.sides.unaffiliatedClubs.length > 0 && (
        <div className="lr-clubs">
          <span className="lr-clubs-t">Registered, not affiliated yet:</span>
          <ul>
            {r.sides.unaffiliatedClubs.map((c) => (
              <li key={c.id}>
                {onOpenClub ? (
                  <button type="button" className="lr-link" onClick={() => onOpenClub(c.id)}>
                    {c.name}
                  </button>
                ) : (
                  c.name
                )}
                {c.sides > 1 && <span className="lr-muted"> ({c.sides} sides)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.status === 'ready' && onStart && (
        <div className="lr-actions">
          <Btn tone="teal" size="sm" aria-label={`Start season — ${label}`} onClick={onStart}>
            Start season
          </Btn>
        </div>
      )}

      {r.status === 'running' && r.run && onOpenSeason && (
        <div className="lr-actions">
          <Btn
            tone="outline"
            size="sm"
            aria-label={`Open season — ${label}`}
            onClick={() => onOpenSeason(r.run!.id)}
          >
            Open season
          </Btn>
        </div>
      )}
    </div>
  );
}
