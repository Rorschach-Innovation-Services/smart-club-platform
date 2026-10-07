/* ─── Chair scorecard confirmation: /sc/:token ───
 *
 * The Monday digest a club chair gets after a week of matches: one card per match with the
 * full medicoach scorecard (batting, bowling, extras, fall of wickets), or the headline result
 * plus a link to medicoach when no scorecard was stored. Per match the chair either confirms
 * the stats or requests a correction (free text, ≤ 2,000 chars); a correction goes to the
 * platform operators. Each match is answered once (first submit wins → 409), then locks.
 *
 * Tenant-independent like the captain's report link (/r/<token>): the token names its tenant
 * and the page themes itself from the digest's branding. Chairs open it from WhatsApp on a
 * phone, so every table scrolls sideways inside its own wrapper instead of widening the page.
 * No optimistic updates: the page always shows what the server returned.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn, Icon, Pill } from './atoms';
import { ApiError, getScorecardConfirmLink, submitScorecardConfirmEntry } from './api';
import { cleanLinkToken, fmtDate, fmtLinkExpiry } from './CaptainsReport';
import { applyTheme } from './config';
import { formatStamp } from './dates';
import { qk } from './query';
import {
  FEEDBACK_MAX,
  STATUS_LABEL,
  STATUS_TONE,
  byOrder,
  extrasLine,
  fallOfWicketsLine,
  feedbackProblem,
  fmtRate,
  headlineScore,
  inningsHeading,
  ownSide,
} from './scorecardConfirmHelpers';
import type {
  InningsScorecard,
  ScorecardConfirmAnswer,
  ScorecardConfirmEntry,
  ScorecardConfirmView,
} from './types';

const errText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong — try again.';

/* ─── Scorecard tables ─── */

function InningsCard({ inn }: { inn: InningsScorecard }) {
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

/** No stored scorecard: the headline result, and medicoach's own page when there is one. */
function HeadlineResult({ entry }: { entry: ScorecardConfirmEntry }) {
  const score = headlineScore(entry);
  return (
    <div className="sc-headline">
      {score ? (
        <div className="sc-headline-score">{score}</div>
      ) : (
        !entry.result?.summary && <div className="cr-section-sub">No score was recorded.</div>
      )}
      {entry.result?.summary && <div className="sc-headline-summary">{entry.result.summary}</div>}
      <div className="cr-section-sub" style={{ marginTop: 6 }}>
        The full scorecard isn&apos;t available on this page.
      </div>
      {entry.medicoachMatchUrl && (
        <a
          className="sc-external"
          href={entry.medicoachMatchUrl}
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

/* ─── The answer: confirm, request a correction, or the locked outcome ─── */

interface AnswerProps {
  entry: ScorecardConfirmEntry;
  submit: (answer: ScorecardConfirmAnswer) => Promise<void>;
}

function Answer({ entry, submit }: AnswerProps) {
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const counterId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  if (entry.status === 'confirmed')
    return (
      <div className="sc-locked sc-locked-ok" role="status">
        <span className="sc-tick">
          <Icon.Check />
        </span>
        <div>
          <strong>You confirmed these stats are correct.</strong>
          {entry.submittedAt && (
            <div className="cr-section-sub">Answered {formatStamp(entry.submittedAt)}</div>
          )}
        </div>
      </div>
    );
  if (entry.status === 'correction')
    return (
      <div className="sc-locked" role="status">
        <strong>You requested a correction.</strong>
        {entry.submittedAt && (
          <div className="cr-section-sub">Sent {formatStamp(entry.submittedAt)}</div>
        )}
        {entry.feedback && (
          <blockquote className="sc-feedback" aria-label="Your correction request">
            {entry.feedback}
          </blockquote>
        )}
        <div className="cr-section-sub">The union&apos;s operators will follow it up.</div>
      </div>
    );
  if (entry.status !== 'pending') return null;

  async function go(answer: ScorecardConfirmAnswer) {
    setBusy(true);
    try {
      await submit(answer);
    } finally {
      setBusy(false);
    }
  }

  function sendCorrection() {
    const why = feedbackProblem(text);
    setProblem(why);
    // Back to the field the error is about, so the chair can type straight away.
    if (why) fieldRef.current?.focus();
    else void go({ action: 'correction', feedback: text.trim() });
  }

  if (!correcting)
    return (
      <div className="sc-actions">
        <Btn
          tone="teal"
          icon={Icon.Check}
          disabled={busy}
          onClick={() => void go({ action: 'confirm' })}
        >
          {busy ? 'Saving…' : 'Confirm — stats are correct'}
        </Btn>
        <Btn tone="outline" disabled={busy} onClick={() => setCorrecting(true)}>
          Request correction
        </Btn>
      </div>
    );

  const over = text.length > FEEDBACK_MAX;
  return (
    <div className="sc-correction">
      <label className="field-label" htmlFor={fieldId}>
        What needs correcting? <span className="req">*</span>
      </label>
      <textarea
        ref={fieldRef}
        id={fieldId}
        className="field-textarea"
        value={text}
        maxLength={FEEDBACK_MAX}
        rows={4}
        aria-describedby={counterId}
        aria-invalid={problem ? true : undefined}
        placeholder="e.g. S. Naidoo scored 46, not 36 — the 4 in the 12th over is missing."
        onChange={(e) => {
          setText(e.target.value);
          if (problem) setProblem(null);
        }}
      />
      <div id={counterId} className={`sc-counter${over ? ' over' : ''}`}>
        {text.length} / {FEEDBACK_MAX}
      </div>
      {problem && (
        <div className="rp-validation" role="alert">
          {problem}
        </div>
      )}
      <div className="sc-actions">
        <Btn tone="teal" disabled={busy} onClick={sendCorrection}>
          {busy ? 'Sending…' : 'Send correction'}
        </Btn>
        <Btn
          tone="outline"
          disabled={busy}
          onClick={() => {
            setCorrecting(false);
            setProblem(null);
          }}
        >
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ─── One match ─── */

function Matchup({ entry, clubName }: { entry: ScorecardConfirmEntry; clubName: string }) {
  const own = ownSide(entry, clubName);
  const team = (side: 'home' | 'away', name: string) =>
    own === side ? <strong>{name}</strong> : <span>{name}</span>;
  return (
    <>
      {team('home', entry.homeTeamName)} <span className="sc-vs">vs</span>{' '}
      {team('away', entry.awayTeamName)}
      {own && <span className="sc-side-tag">{own === 'home' ? 'Home' : 'Away'}</span>}
    </>
  );
}

function MatchCard({
  entry,
  clubName,
  notice,
  submit,
}: {
  entry: ScorecardConfirmEntry;
  clubName: string;
  notice?: ReactNode;
  submit: AnswerProps['submit'];
}) {
  const label = `${entry.homeTeamName} vs ${entry.awayTeamName}`;
  const isVoid = entry.status === 'void';
  return (
    <section
      className={`rp-section sc-match${isVoid ? ' sc-match-void' : ''}`}
      aria-label={label}
      data-testid={`sc-entry-${entry.entryKey}`}
    >
      <div className="sc-match-head">
        <div>
          <div className="rp-section-eyebrow">{fmtDate(entry.fixtureDate)}</div>
          <div className="sc-match-title">
            <Matchup entry={entry} clubName={clubName} />
          </div>
        </div>
        <Pill tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Pill>
      </div>
      {(entry.competition || entry.venue || entry.result?.summary) && (
        <dl className="cr-facts">
          {entry.competition && (
            <div>
              <dt>Competition</dt>
              <dd>{entry.competition}</dd>
            </div>
          )}
          {entry.venue && (
            <div>
              <dt>Venue</dt>
              <dd>{entry.venue}</dd>
            </div>
          )}
          {entry.result?.summary && entry.scorecard && (
            <div>
              <dt>Result</dt>
              <dd>{entry.result.summary}</dd>
            </div>
          )}
        </dl>
      )}
      {isVoid ? (
        <div className="sc-void">
          This result was withdrawn after the digest went out, so there is nothing to confirm for
          this match.
        </div>
      ) : (
        <>
          {entry.scorecard && entry.scorecard.innings.length > 0 ? (
            <div className="sc-scorecard">
              {entry.scorecard.innings.map((inn, i) => (
                <InningsCard key={i} inn={inn} />
              ))}
            </div>
          ) : (
            <HeadlineResult entry={entry} />
          )}
          {notice && (
            <div className="cr-section-sub" role="status" style={{ marginTop: 12 }}>
              {notice}
            </div>
          )}
          <Answer key={entry.status} entry={entry} submit={submit} />
        </>
      )}
    </section>
  );
}

/* ─── The page ─── */

function ClosedCard({ title, sub, action }: { title: string; sub: ReactNode; action?: ReactNode }) {
  return (
    <div className="cr-done">
      <div className="cr-done-title">{title}</div>
      <div className="cr-done-sub">{sub}</div>
      {action && <div className="cr-done-actions">{action}</div>}
    </div>
  );
}

export function ScorecardConfirmLinkPage() {
  const { token: rawToken = '' } = useParams();
  const token = cleanLinkToken(rawToken);
  const qc = useQueryClient();
  const key = qk.linkedScorecardConfirm(token);
  const query = useQuery({
    queryKey: key,
    queryFn: () => getScorecardConfirmLink(token),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: Infinity,
  });
  const data = query.data;
  // Per-match notes after an answer: "already answered" (409) or a submit error.
  const [notes, setNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    applyTheme({
      colors: data.branding.colors,
      logoUrl: data.branding.logoUrl,
      title: `${data.branding.name} · Scorecards`,
    });
  }, [data]);

  async function submit(entry: ScorecardConfirmEntry, answer: ScorecardConfirmAnswer) {
    setNotes((n) => {
      const next = { ...n };
      delete next[entry.entryKey];
      return next;
    });
    try {
      // Echo the scorecard version this page rendered: the server records the answer
      // against it, not whatever card it holds by the time the answer lands.
      const view = await submitScorecardConfirmEntry(token, entry.seriesId, entry.fixtureId, {
        ...answer,
        ...(entry.scorecard && entry.scorecardFetchedAt
          ? { scorecardFetchedAt: entry.scorecardFetchedAt }
          : {}),
      });
      qc.setQueryData<ScorecardConfirmView>(key, view);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 410)) {
        // Answered elsewhere (another tab, a forwarded link) or the link just closed: show
        // what the server holds now rather than our stale copy.
        if (err.status === 409)
          setNotes((n) => ({
            ...n,
            [entry.entryKey]: 'This match was already answered — showing the saved answer.',
          }));
        await query.refetch();
        return;
      }
      setNotes((n) => ({ ...n, [entry.entryKey]: errText(err) }));
    }
  }

  const status = query.error instanceof ApiError ? query.error.status : null;
  let body: ReactNode;
  if (query.isLoading) body = <div className="cr-section-sub">Loading your scorecards…</div>;
  else if (status === 410)
    body = (
      <ClosedCard
        title="This link has expired"
        sub={
          <>
            {query.error instanceof ApiError && `${query.error.message.replace(/\.$/, '')}. `}
            If a scorecard still needs correcting, contact the union office.
          </>
        }
      />
    );
  else if (!data && status !== null)
    body = (
      <ClosedCard
        title="This link isn't valid"
        sub="Check you opened the full link from the message."
      />
    );
  else if (!data)
    body = (
      <ClosedCard
        title="Couldn't load your scorecards"
        sub="Check your connection and try again — the link itself is still good."
        action={
          <Btn tone="teal" onClick={() => void query.refetch()}>
            Try again
          </Btn>
        }
      />
    );
  else {
    const open = data.entries.filter((e) => e.status !== 'void');
    const answered = open.filter((e) => e.status !== 'pending').length;
    body = (
      <>
        <div className="page-head">
          <div className="ph-left">
            <div className="ph-crumb">
              {data.clubName} / Scorecards ·{' '}
              <span style={{ whiteSpace: 'nowrap' }}>{data.ref}</span>
            </div>
            <h1 className="ph-title">
              Weekend <em>scorecards</em>
            </h1>
            <p className="ph-desc">
              {data.weekLabel}. Check each match below: confirm the stats are correct, or tell us
              what needs correcting.
              {data.linkExpiresAt ? ` Link expires ${fmtLinkExpiry(data.linkExpiresAt)}.` : ''}
            </p>
          </div>
        </div>
        {open.length > 0 && (
          <div className="sc-progress" role="status">
            {answered === open.length
              ? `All ${open.length} ${open.length === 1 ? 'match' : 'matches'} answered — thank you.`
              : `${answered} of ${open.length} ${open.length === 1 ? 'match' : 'matches'} answered`}
          </div>
        )}
        {data.entries.length === 0 ? (
          <ClosedCard title="Nothing to check" sub="This digest has no matches." />
        ) : (
          <div className="sc-matches">
            {data.entries.map((e) => (
              <MatchCard
                key={e.entryKey}
                entry={e}
                clubName={data.clubName}
                notice={notes[e.entryKey]}
                submit={(answer) => submit(e, answer)}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="cr-link-shell">
      <header className="cr-link-header">
        {data?.branding.logoUrl && <img src={data.branding.logoUrl} alt="" />}
        <strong>{data?.branding.name ?? 'Scorecards'}</strong>
      </header>
      <main className="cr-link-main sc-main">{body}</main>
    </div>
  );
}
