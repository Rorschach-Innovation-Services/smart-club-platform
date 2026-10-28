/* ─── Pre-match captain squad links: the public /sq/<token> page ───
 *
 * The evening before a match the side's captain (or, failing one, the club chair) gets a link
 * to name the squad. The page is roster-first: search the club's registered players and tick
 * them; a guest (someone not on the roster) can only be added once the search finds nobody,
 * behind a confirm step — guests aren't linked to player records, so the guard keeps a
 * mistyped search from minting a duplicate of a registered player.
 *
 * Unlike the captain's report, a SUBMITTED squad stays editable until the link expires
 * (23:59:59 SAST on match day). Every save carries the `modified` it rendered; a 409 means the
 * squad changed elsewhere, so the page reloads the latest and says so. The chair's link can
 * send the request on to a player (a clone of the captain's report "Send to captain" flow).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn } from './atoms';
import { cleanLinkToken, fmtDate, fmtLinkExpiry } from './CaptainsReport';
import {
  ApiError,
  forwardLinkedSquadRequest,
  getLinkedSquadRequest,
  getSquadForwardCandidates,
  putLinkedSquadRequest,
  type ForwardCandidates,
} from './api';
import { applyTheme } from './config';
import { qk } from './query';
import type { LinkedSquadRequest, SquadRequestView, SquadSaveBody } from './types';

const errText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong — try again.';

const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STALE_NOTE =
  'This squad was changed somewhere else while you had it open, so your view was out of date. ' +
  "We've loaded the latest version — check it and save again.";

export const squadMatchLine = (r: Pick<SquadRequestView, 'teamName' | 'opponentName' | 'side'>) =>
  r.side === 'home' ? `${r.teamName} v ${r.opponentName}` : `${r.opponentName} v ${r.teamName}`;

/* ─── The selection form ─── */

interface SquadFormProps {
  data: LinkedSquadRequest;
  busy: boolean;
  onSave: (body: Omit<SquadSaveBody, 'expectedModified'>) => void;
  onCancel?: () => void;
}

export function SquadSelectionForm({ data, busy, onSave, onCancel }: SquadFormProps) {
  const { request, roster, maxPlayers } = data;
  const nameById = useMemo(() => new Map(roster.map((p) => [p.id, p.name])), [roster]);
  const [picked, setPicked] = useState<string[]>(
    () => request.selection?.players.map((p) => p.id ?? '').filter((id) => nameById.has(id)) ?? [],
  );
  const [guests, setGuests] = useState<Array<{ name: string }>>(
    () => request.selection?.guests ?? [],
  );
  const [captainId, setCaptainId] = useState<string>(() => request.selection?.captainId ?? '');
  const [search, setSearch] = useState('');
  const [confirmGuest, setConfirmGuest] = useState(false);

  const term = search.trim().replace(/\s+/g, ' ');
  const matches = useMemo(() => {
    const q = term.toLowerCase();
    return q ? roster.filter((p) => p.name.toLowerCase().includes(q)) : roster;
  }, [roster, term]);
  // The guest guard: only when a real search finds nobody on the roster.
  const noMatch = term.length > 0 && matches.length === 0;
  const full = picked.length >= maxPlayers;

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) {
        if (captainId === id) setCaptainId('');
        return prev.filter((x) => x !== id);
      }
      return prev.length >= maxPlayers ? prev : [...prev, id];
    });
  }

  function addGuest() {
    if (!term || guests.length >= maxPlayers) return;
    setGuests((g) => [...g, { name: term }]);
    setSearch('');
    setConfirmGuest(false);
  }

  const total = picked.length + guests.length;
  const body = (submit: boolean) => ({
    players: picked,
    guests,
    captainId: captainId || null,
    submit,
  });

  return (
    <div className="sq-form">
      <div className="rp-section">
        <div className="rp-section-title">Pick your squad</div>
        <div className="cr-section-sub">
          Search the club's registered players and tick everyone playing.
        </div>
        <input
          type="search"
          className="field-input"
          aria-label="Search players"
          placeholder="Search by name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setConfirmGuest(false);
          }}
          style={{ width: '100%', margin: '10px 0' }}
        />
        {noMatch ? (
          <div className="sq-guest" aria-label="Add a guest">
            {!confirmGuest ? (
              <>
                <div className="cr-section-sub">No registered player matches “{term}”.</div>
                <Btn tone="outline" size="sm" onClick={() => setConfirmGuest(true)}>
                  Not finding them? Add as guest
                </Btn>
              </>
            ) : (
              <div role="alertdialog" aria-label={`Add ${term} as a guest`}>
                <div className="cr-section-sub">
                  Add “{term}” as a guest? Guests aren't linked to player records — check the
                  spelling first if they are registered with the club.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Btn
                    tone="teal"
                    size="sm"
                    disabled={guests.length >= maxPlayers}
                    onClick={addGuest}
                  >
                    Add guest
                  </Btn>
                  <Btn tone="ghost" size="sm" onClick={() => setConfirmGuest(false)}>
                    Cancel
                  </Btn>
                </div>
              </div>
            )}
          </div>
        ) : (
          <ul
            className="sq-roster"
            aria-label="Club players"
            style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 320, overflowY: 'auto' }}
          >
            {matches.map((p) => {
              const on = picked.includes(p.id);
              return (
                <li key={p.id}>
                  <label
                    style={{ display: 'flex', gap: 8, padding: '6px 0', alignItems: 'center' }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!on && full}
                      onChange={() => toggle(p.id)}
                    />
                    {p.name}
                  </label>
                </li>
              );
            })}
            {!roster.length && (
              <li className="cr-section-sub">No registered players found for this club.</li>
            )}
          </ul>
        )}
      </div>

      <div className="rp-section" aria-label="Selected squad">
        <div className="rp-section-title">
          Selected squad <span className="cr-chip-n">{total}</span>
        </div>
        {!total ? (
          <div className="cr-section-sub">Nobody selected yet.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
            {picked.map((id) => (
              <li key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {nameById.get(id)}
                  {captainId === id ? ' (captain)' : ''}
                </span>
                <Btn
                  tone="ghost"
                  size="sm"
                  aria-label={`Remove ${nameById.get(id)}`}
                  onClick={() => toggle(id)}
                >
                  Remove
                </Btn>
              </li>
            ))}
            {guests.map((g, i) => (
              <li
                key={`g${i}`}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
              >
                <span>
                  {g.name} <span className="cr-section-sub">(guest)</span>
                </span>
                <Btn
                  tone="ghost"
                  size="sm"
                  aria-label={`Remove guest ${g.name}`}
                  onClick={() => setGuests((all) => all.filter((_, j) => j !== i))}
                >
                  Remove
                </Btn>
              </li>
            ))}
          </ul>
        )}
        {picked.length > 0 && (
          <label style={{ display: 'block', marginTop: 8 }}>
            <span className="cr-section-sub">Captain</span>{' '}
            <select
              className="field-select"
              aria-label="Captain"
              value={captainId}
              onChange={(e) => setCaptainId(e.target.value)}
            >
              <option value="">No captain named</option>
              {picked.map((id) => (
                <option key={id} value={id}>
                  {nameById.get(id)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Btn tone="outline" disabled={busy} onClick={() => onSave(body(false))}>
          Save draft
        </Btn>
        <Btn tone="teal" disabled={busy || total === 0} onClick={() => onSave(body(true))}>
          Submit squad
        </Btn>
        {onCancel && (
          <Btn tone="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Btn>
        )}
      </div>
    </div>
  );
}

/* ─── The submitted squad (still editable until the link expires) ─── */

function SubmittedSquad({ request, onEdit }: { request: SquadRequestView; onEdit: () => void }) {
  const sel = request.selection;
  return (
    <div className="rp-section" aria-label="Submitted squad">
      <div className="cr-done-title">Squad submitted</div>
      <div className="cr-section-sub">
        You can still change it until the link expires
        {request.linkExpiresAt ? ` (${fmtLinkExpiry(request.linkExpiresAt)})` : ''}.
      </div>
      <ul style={{ margin: '10px 0' }}>
        {sel?.players.map((p, i) => (
          <li key={p.id ?? i}>
            {p.name}
            {sel.captainId && p.id === sel.captainId ? ' (captain)' : ''}
          </li>
        ))}
        {sel?.guests.map((g, i) => (
          <li key={`g${i}`}>{g.name} (guest)</li>
        ))}
      </ul>
      <Btn tone="outline" onClick={onEdit}>
        Edit squad
      </Btn>
    </div>
  );
}

/* ─── Send on (the chair's link only) ─── */

interface SquadSendOnProps {
  token: string;
  current: SquadRequestView['recipient'];
  onSent: (res: LinkedSquadRequest, name: string) => void;
  onError: (message: string) => void;
}

/**
 * Clone of the captain's report SendToCaptain, for squad links: pick one of the club's own
 * registered adult players with a contact on file; they get their own link. Names only.
 */
function SquadSendOn({ token, current, onSent, onError }: SquadSendOnProps) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const query = useQuery<ForwardCandidates>({
    queryKey: ['squad-link-forward', token],
    queryFn: () => getSquadForwardCandidates(token),
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: (id: string) => forwardLinkedSquadRequest(token, id),
    onSuccess: (res) => {
      const name = query.data?.candidates.find((c) => c.id === pick)?.name ?? 'the captain';
      setSentTo(name);
      setOpen(false);
      setPick('');
      onSent(res, name);
      void query.refetch();
    },
    onError: (err) => onError(errText(err)),
  });
  const remaining = query.data?.remaining;
  const forwarded = current.forwardedBy ? current.name : null;
  return (
    <div className="rp-section cr-forward" aria-label="Send to captain">
      <div className="cr-forward-head">
        <div>
          <strong>Not picking the squad yourself?</strong>
          <div className="cr-section-sub">
            {sentTo || forwarded
              ? `Sent to ${sentTo ?? forwarded}. Your own link still works until it expires.`
              : 'Send this squad link to the match captain. They get their own link; yours keeps working until it expires.'}
          </div>
        </div>
        {!open && (
          <Btn tone="outline" size="sm" onClick={() => setOpen(true)}>
            Send to captain
          </Btn>
        )}
      </div>
      {open && (
        <div className="cr-forward-pick">
          {query.isLoading ? (
            <div className="cr-section-sub">Loading players…</div>
          ) : query.error ? (
            <div className="rp-validation">{errText(query.error)}</div>
          ) : !query.data?.candidates.length ? (
            <div className="cr-section-sub">
              No registered adult player has an email or cell on file. Ask the captain to update
              their registration, or pick the squad yourself.
            </div>
          ) : remaining === 0 ? (
            <div className="cr-section-sub">
              This squad link has already been sent on 3 times. Pick the squad yourself.
            </div>
          ) : (
            <>
              <select
                className="field-select"
                aria-label="Send to player"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">Choose a player</option>
                {query.data.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Btn
                tone="teal"
                size="sm"
                disabled={!pick || mutation.isPending}
                onClick={() => mutation.mutate(pick)}
              >
                Send
              </Btn>
            </>
          )}
          <Btn tone="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Btn>
        </div>
      )}
    </div>
  );
}

/* ─── The page ─── */

export function SquadSelectionLinkPage() {
  const { token: rawToken = '' } = useParams();
  const token = cleanLinkToken(rawToken);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const query = useQuery({
    queryKey: qk.linkedSquadRequest(token),
    queryFn: () => getLinkedSquadRequest(token),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: Infinity,
  });
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    applyTheme({
      colors: data.tenantBranding.colors,
      logoUrl: data.tenantBranding.logoUrl,
      title: `${data.tenantBranding.name} · Squad selection`,
    });
  }, [data]);

  const put = useMutation({
    mutationFn: (body: SquadSaveBody) => putLinkedSquadRequest(token, body),
    onSuccess: (res, body) => {
      setError(null);
      qc.setQueryData(qk.linkedSquadRequest(token), res);
      if (body.submit) {
        setEditing(false);
        setNote('Squad submitted. You can still change it until the link expires.');
      } else setNote('Draft saved.');
    },
    onError: async (err) => {
      setNote(null);
      if (err instanceof ApiError && err.status === 409) {
        // Stale tab: load the latest and re-render the form from it.
        setError(STALE_NOTE);
        await query.refetch();
        return;
      }
      if (err instanceof ApiError && err.status === 410) {
        // The link closed while the page was open: show the closed state.
        await query.refetch();
        return;
      }
      setError(errText(err));
    },
  });

  const status = query.error instanceof ApiError ? query.error.status : null;
  // A transient fixture read (410 "temporarily unavailable") is NOT a dead link — the
  // sweep self-heals it; don't title it "closed" or the captain gives up.
  const transient =
    query.error instanceof ApiError && /temporarily unavailable/i.test(query.error.message);
  let body: ReactNode;
  if (query.isLoading) body = <div className="cr-section-sub">Loading the squad…</div>;
  else if (status === 410)
    body = (
      <div className="cr-done">
        <div className="cr-done-title">
          {transient ? 'This link is temporarily unavailable' : 'This squad link is closed'}
        </div>
        <div className="cr-done-sub">
          {query.error instanceof ApiError && sentenceCase(query.error.message.replace(/\.$/, ''))}.
        </div>
      </div>
    );
  else if (!data && status !== null)
    body = (
      <div className="cr-done">
        <div className="cr-done-title">This link isn't valid</div>
        <div className="cr-done-sub">Check you opened the full link from the message.</div>
      </div>
    );
  else if (!data)
    body = (
      <div className="cr-done">
        <div className="cr-done-title">Couldn't load the squad</div>
        <div className="cr-done-sub">
          Check your connection and try again — the link itself is still good.
        </div>
        <div className="cr-done-actions">
          <Btn tone="teal" onClick={() => void query.refetch()}>
            Try again
          </Btn>
        </div>
      </div>
    );
  else {
    const r = data.request;
    const submitted = r.status === 'submitted';
    body = (
      <>
        <div className="page-head">
          <div className="ph-left">
            <div className="ph-crumb">{r.clubName} / Squad selection</div>
            <h1 className="ph-title">
              Match <em>squad</em>
            </h1>
            <p className="ph-desc">
              {squadMatchLine(r)} · {fmtDate(r.matchDate)} · {r.competition}
              {r.venue ? ` · ${r.venue}` : ''}. Name the squad for {r.teamName}.
              {r.linkExpiresAt ? ` Link expires ${fmtLinkExpiry(r.linkExpiresAt)}.` : ''}
            </p>
          </div>
        </div>
        {error && (
          <div className="rp-validation" role="alert" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        {note && (
          <div className="cr-section-sub" role="status" style={{ marginBottom: 12 }}>
            {note}
          </div>
        )}
        {data.canForward && (
          <SquadSendOn
            token={token}
            current={r.recipient}
            onSent={(res, name) => {
              qc.setQueryData(qk.linkedSquadRequest(token), res);
              setError(null);
              setNote(`Sent to ${name}. They will get their own link.`);
            }}
            onError={setError}
          />
        )}
        {submitted && !editing ? (
          <SubmittedSquad
            request={r}
            onEdit={() => {
              setNote(null);
              setEditing(true);
            }}
          />
        ) : (
          <SquadSelectionForm
            // Remount from the server copy whenever it changes (a save, or a stale reload).
            key={r.modified}
            data={data}
            busy={put.isPending}
            onCancel={submitted ? () => setEditing(false) : undefined}
            onSave={(b) => put.mutate({ ...b, expectedModified: r.modified })}
          />
        )}
      </>
    );
  }

  return (
    <div className="cr-link-shell">
      <header className="cr-link-header">
        {data?.tenantBranding.logoUrl && <img src={data.tenantBranding.logoUrl} alt="" />}
        <strong>{data?.tenantBranding.name ?? 'Squad selection'}</strong>
      </header>
      <main className="cr-link-main">{body}</main>
    </div>
  );
}
