/* ─── Scorecard building blocks ───
 *
 * The medicoach scorecard as the platform renders it: one card per innings (batting, extras,
 * bowling, fall of wickets), the headline result when no scorecard was stored, and the
 * controlled correction-request field. Shared by the captain's report and the chair digest.
 *
 * Captains and chairs open these from WhatsApp on a phone, so every table scrolls sideways
 * inside its own focusable wrapper instead of widening the page.
 */
import type { Ref } from 'react';
import { Icon } from './atoms';
import {
  FEEDBACK_MAX,
  byOrder,
  extrasLine,
  fallOfWicketsLine,
  fmtRate,
  headlineScore,
  inningsHeading,
} from './scorecardConfirmHelpers';
import type { InningsScorecard } from './types';

/* ─── Scorecard tables ─── */

export function InningsCard({ inn }: { inn: InningsScorecard }) {
  const fow = fallOfWicketsLine(inn.fallOfWickets);
  return (
    <div className="sc-innings">
      <h3 className="sc-innings-head">{inningsHeading(inn)}</h3>
      <div
        className="sc-table-wrap"
        role="region"
        aria-label={`${inn.battingTeamName} batting`}
        tabIndex={0}
      >
        <table className="sc-table">
          <thead>
            <tr>
              <th>Batter</th>
              <th>Dismissal</th>
              <th className="num">R</th>
              <th className="num">B</th>
              <th className="num">4s</th>
              <th className="num">6s</th>
              <th className="num">SR</th>
            </tr>
          </thead>
          <tbody>
            {byOrder(inn.batters).map((b) => (
              <tr key={`${b.order}-${b.name}`}>
                <td className="sc-name">{b.name}</td>
                <td className="sc-howout">{b.howOut}</td>
                <td className="num">
                  <strong>{b.runs}</strong>
                </td>
                <td className="num">{b.ballsFaced}</td>
                <td className="num">{b.fours}</td>
                <td className="num">{b.sixes}</td>
                <td className="num">{fmtRate(b.strikeRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sc-line">{extrasLine(inn.extras)}</div>
      <div
        className="sc-table-wrap"
        role="region"
        aria-label={`Bowling to ${inn.battingTeamName}`}
        tabIndex={0}
      >
        <table className="sc-table">
          <thead>
            <tr>
              <th>Bowler</th>
              <th className="num">O</th>
              <th className="num">M</th>
              <th className="num">R</th>
              <th className="num">W</th>
              <th className="num">Econ</th>
              <th className="num">Wd</th>
              <th className="num">Nb</th>
            </tr>
          </thead>
          <tbody>
            {byOrder(inn.bowlers).map((b) => (
              <tr key={`${b.order}-${b.name}`}>
                <td className="sc-name">{b.name}</td>
                <td className="num">{b.overs}</td>
                <td className="num">{b.maidens}</td>
                <td className="num">{b.runsConceded}</td>
                <td className="num">
                  <strong>{b.wickets}</strong>
                </td>
                <td className="num">{fmtRate(b.economy)}</td>
                <td className="num">{b.wides}</td>
                <td className="num">{b.noBalls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fow && (
        <div className="sc-line">
          <span className="sc-line-label">Fall of wickets:</span> {fow}
        </div>
      )}
    </div>
  );
}

/** What the headline result needs: the two team names, the stored result and medicoach's link. */
export interface HeadlineMatch {
  homeTeamName: string;
  awayTeamName: string;
  result?: {
    homeScore: string | null;
    awayScore: string | null;
    summary?: string;
  };
  medicoachMatchUrl?: string;
}

/** No stored scorecard: the headline result, and medicoach's own page when there is one. */
export function HeadlineResult({ match }: { match: HeadlineMatch }) {
  const score = headlineScore(match);
  return (
    <div className="sc-headline">
      {score ? (
        <div className="sc-headline-score">{score}</div>
      ) : (
        !match.result?.summary && <div className="cr-section-sub">No score was recorded.</div>
      )}
      {match.result?.summary && <div className="sc-headline-summary">{match.result.summary}</div>}
      <div className="cr-section-sub" style={{ marginTop: 6 }}>
        The full scorecard isn&apos;t available on this page.
      </div>
      {match.medicoachMatchUrl && (
        <a
          className="sc-external"
          href={match.medicoachMatchUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View full scorecard
          <Icon.Arrow />
        </a>
      )}
    </div>
  );
}

/* ─── The correction request (controlled) ─── */

export interface CorrectionFieldProps {
  id: string;
  counterId: string;
  value: string;
  onChange: (text: string) => void;
  /** The inline problem (blank / too long), shown as an alert under the counter. */
  problem: string | null;
  fieldRef?: Ref<HTMLTextAreaElement>;
  disabled?: boolean;
}

/** "What needs correcting?" — a ≤ FEEDBACK_MAX textarea with a live counter and its problem. */
export function CorrectionField({
  id,
  counterId,
  value,
  onChange,
  problem,
  fieldRef,
  disabled,
}: CorrectionFieldProps) {
  const over = value.length > FEEDBACK_MAX;
  return (
    <>
      <label className="field-label" htmlFor={id}>
        What needs correcting? <span className="req">*</span>
      </label>
      <textarea
        ref={fieldRef}
        id={id}
        className="field-textarea"
        value={value}
        maxLength={FEEDBACK_MAX}
        rows={4}
        disabled={disabled}
        aria-describedby={counterId}
        aria-invalid={problem ? true : undefined}
        placeholder="e.g. S. Naidoo scored 46, not 36 — the 4 in the 12th over is missing."
        onChange={(e) => onChange(e.target.value)}
      />
      <div id={counterId} className={`sc-counter${over ? ' over' : ''}`}>
        {value.length} / {FEEDBACK_MAX}
      </div>
      {problem && (
        <div className="rp-validation" role="alert">
          {problem}
        </div>
      )}
    </>
  );
}
