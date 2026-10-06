/**
 * Platform → Match library: the one place professional results come in. The operator drops
 * the exports (scorecard CSVs, ball-by-ball CSVs, or standard match files) in any number and
 * any order; they are read in the browser and checked against the library — new, adds the
 * ball-by-ball to a game already there, duplicate, or doesn't add up — before anything is
 * saved. Every union's scouting reads the same library (/admin/pro/matches).
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './api';
import { Btn, Card, EmptyState, Icon, Pill } from './atoms';
import {
  planImport,
  readFile,
  type LibraryMatch,
  type Outcome,
  type PlanItem,
  type ReadFile,
} from './match-import';
import { shortTeam } from './pro-scorecards';
import { ERR, HINT } from './platform-wizard';
import { qk } from './query';

type Toast = (m: string, t?: string) => void;

/** The API takes 25 matches per request. */
export const SAVE_BATCH = 25;

const OUTCOME: Record<Outcome, { label: string; tone: string; saves: boolean }> = {
  new: { label: 'New match', tone: 'teal', saves: true },
  'adds-balls': { label: 'Adds ball by ball', tone: 'teal', saves: true },
  'adds-scorecard': { label: 'Adds scorecard', tone: 'teal', saves: true },
  duplicate: { label: 'Duplicate · skipped', tone: 'muted', saves: false },
  conflict: { label: 'Doesn’t add up · skipped', tone: 'coral', saves: false },
  unrecognised: { label: 'Not a match file', tone: 'coral', saves: false },
  error: { label: 'Couldn’t read', tone: 'coral', saves: false },
};
const ORDER: Outcome[] = [
  'conflict',
  'error',
  'unrecognised',
  'new',
  'adds-balls',
  'adds-scorecard',
  'duplicate',
];
const KIND: Record<ReadFile['kind'], string> = {
  scorecard: 'Scorecard',
  'ball-by-ball': 'Ball by ball',
  standard: 'Standard file',
  unknown: '—',
};

// FileReader rather than File.text(): the same in every browser and in jsdom.
const textOf = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(f);
  });

const readAll = (list: FileList | File[]) =>
  Promise.all(
    [...list]
      .filter((f) => /\.(csv|json)$/i.test(f.name))
      .map(async (f) => readFile(f.name, await textOf(f))),
  );

export function MatchLibraryPage({ toast }: { toast: Toast }) {
  const queryClient = useQueryClient();
  const lib = useQuery({ queryKey: qk.platformProMatches(), queryFn: api.platformGetProMatches });
  const [files, setFiles] = useState<ReadFile[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const plan = useMemo(
    () => (files.length && lib.data ? planImport(lib.data, files) : null),
    [files, lib.data],
  );

  const take = async (list: FileList | File[]) => {
    setReading(true);
    try {
      const read = await readAll(list);
      setSkipped([...list].length - read.length);
      // Dropping more files adds to the batch; the same file name replaces itself.
      setFiles((cur) => [...cur.filter((f) => !read.some((r) => r.name === f.name)), ...read]);
    } finally {
      setReading(false);
    }
  };

  const save = useMutation({
    mutationFn: async (matches: LibraryMatch[]) => {
      const saved: string[] = [];
      for (let i = 0; i < matches.length; i += SAVE_BATCH) {
        setProgress(`Saving ${Math.min(i + SAVE_BATCH, matches.length)} of ${matches.length}…`);
        const r = await api.platformSaveProMatches(matches.slice(i, i + SAVE_BATCH));
        saved.push(...r.saved);
      }
      return saved;
    },
    onSuccess: (saved) => {
      toast(`${saved.length} match${saved.length === 1 ? '' : 'es'} saved to the library`);
      setFiles([]);
      setSkipped(0);
    },
    onError: (e) =>
      toast(
        `Saving stopped: ${e instanceof Error ? e.message : 'try again'}. Anything before it was saved — drop the files again to finish.`,
        'error',
      ),
    onSettled: () => {
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: qk.platformProMatches() });
      void queryClient.invalidateQueries({ queryKey: qk.proMatches() });
    },
  });

  const counts = useMemo(() => {
    const c = {} as Record<Outcome, number>;
    plan?.items.forEach((i) => (c[i.outcome] = (c[i.outcome] ?? 0) + 1));
    return c;
  }, [plan]);
  const items = useMemo(
    () =>
      [...(plan?.items ?? [])].sort(
        (a, b) =>
          ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome) ||
          (a.key ?? a.name).localeCompare(b.key ?? b.name),
      ),
    [plan],
  );

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Platform / Match library</div>
          <h1 className="ph-title">
            Match <em>library</em>
          </h1>
          <p className="ph-desc">
            Professional scorecards and ball by ball, shared by every union&rsquo;s scouting. Drop
            the exports in; duplicates and files that don&rsquo;t add up are caught before anything
            is saved.
          </p>
        </div>
      </div>

      <Card
        title="1. Drop the files"
        sub="Read in your browser — nothing is saved until you confirm below."
      >
        <div
          className="ml-drop"
          data-testid="ml-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) void take(e.dataTransfer.files);
          }}
        >
          <Icon.Upload />
          <p className="ml-drop-title">Drop scorecards and ball-by-ball files here</p>
          <p style={HINT}>
            As many as you like, in any order — each game&rsquo;s two files are paired.
          </p>
          <input
            ref={input}
            type="file"
            multiple
            accept=".csv,.json,text/csv,application/json"
            aria-label="Choose match files"
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = e.target.files ? [...e.target.files] : [];
              e.target.value = '';
              if (list.length) void take(list);
            }}
          />
          <Btn
            tone="outline"
            size="sm"
            disabled={reading}
            onClick={() => input.current?.click()}
            style={{ marginTop: 10 }}
          >
            {reading ? 'Reading…' : 'Choose files'}
          </Btn>
        </div>
        <details className="ml-formats">
          <summary>Which files?</summary>
          <ul>
            <li>
              <strong>Scorecard CSV</strong> — the export with &ldquo;MATCH INFO&rdquo;, batting,
              bowling and fall of wickets per innings. The official record of the cards.
            </li>
            <li>
              <strong>Ball by Ball CSV</strong> — one row per delivery (match_id, competition, date,
              innings_no, over_ball, outcome…). Adds overs, phases and spells to its game.
            </li>
            <li>
              <strong>Standard match file</strong> (.json) — matches exported from a library.
            </li>
          </ul>
          <p style={HINT}>
            A game is the same date, the same two teams and the same first-innings total (a
            ball-by-ball may be a few runs short of its scorecard). A ball-by-ball that is far off
            its scorecard isn&rsquo;t attached — it is listed for you to check.
          </p>
        </details>
        {skipped > 0 && (
          <div style={ERR}>
            {skipped} file{skipped === 1 ? '' : 's'} left out — only .csv and .json are read.
          </div>
        )}
      </Card>

      {files.length > 0 && (
        <Card
          title="2. Check what will happen"
          sub={
            lib.isLoading
              ? 'Loading the library to check against…'
              : `${files.length} file${files.length === 1 ? '' : 's'} against ${lib.data?.length ?? 0} match${lib.data?.length === 1 ? '' : 'es'} in the library.`
          }
        >
          {lib.isError && (
            <div style={ERR}>
              The library couldn&rsquo;t be loaded, so duplicates can&rsquo;t be checked — refresh
              to retry.
            </div>
          )}
          {plan && (
            <>
              <div className="ml-counts" aria-label="Upload summary">
                {ORDER.filter((o) => counts[o]).map((o) => (
                  <Pill key={o} tone={OUTCOME[o].tone}>
                    {counts[o]} · {OUTCOME[o].label}
                  </Pill>
                ))}
              </div>
              <PlanTable items={items} />
              <div className="ml-actions">
                <Btn
                  tone="teal"
                  disabled={!plan.save.length || save.isPending}
                  onClick={() => save.mutate(plan.save)}
                >
                  {progress ??
                    (plan.save.length
                      ? `Save ${plan.save.length} match${plan.save.length === 1 ? '' : 'es'}`
                      : 'Nothing new to save')}
                </Btn>
                <Btn
                  tone="ghost"
                  disabled={save.isPending}
                  onClick={() => {
                    setFiles([]);
                    setSkipped(0);
                  }}
                >
                  Clear
                </Btn>
              </div>
            </>
          )}
        </Card>
      )}

      <LibraryCard lib={lib.data} loading={lib.isLoading} failed={lib.isError} toast={toast} />
    </div>
  );
}

/** Past this many files, start with only the ones that need a look. */
export const PLAN_SHORT = 20;
const needsLook = (i: PlanItem) => !OUTCOME[i.outcome].saves || i.warnings.length > 0;

function PlanTable({ items }: { items: PlanItem[] }) {
  const [all, setAll] = useState(false);
  const short = items.length > PLAN_SHORT && !all;
  const shown = short ? items.filter((i) => i.outcome !== 'duplicate' && needsLook(i)) : items;
  return (
    <div className="tbl-w">
      {items.length > PLAN_SHORT && (
        <div className="ml-plan-head">
          <span>
            {short
              ? `${shown.length} of ${items.length} files need a look (skipped, or saved with a warning).`
              : `All ${items.length} files.`}
          </span>
          <Btn tone="ghost" size="sm" onClick={() => setAll((v) => !v)}>
            {short ? `Show all ${items.length} files` : 'Show only those that need a look'}
          </Btn>
        </div>
      )}
      <table className="tbl ml-tbl" aria-label="What each file will do">
        <thead>
          <tr>
            <th>File</th>
            <th>Type</th>
            <th>What happens</th>
            <th>Game</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((i, k) => (
            <tr key={`${i.name}-${k}`}>
              <td className="ml-file">{i.name}</td>
              <td>{KIND[i.kind]}</td>
              <td>
                <Pill tone={OUTCOME[i.outcome].tone}>{OUTCOME[i.outcome].label}</Pill>
              </td>
              <td>
                <div>{i.summary}</div>
                {i.warnings.map((w) => (
                  <div key={w} className="ml-warn">
                    {w}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LibraryCard({
  lib,
  loading,
  failed,
  toast,
}: {
  lib?: LibraryMatch[];
  loading: boolean;
  failed: boolean;
  toast: Toast;
}) {
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const del = useMutation({
    mutationFn: api.platformDeleteProMatch,
    onSuccess: () => toast('Match removed from the library'),
    onError: () => toast('Could not remove that match — try again', 'error'),
    onSettled: () => {
      setConfirm(null);
      void queryClient.invalidateQueries({ queryKey: qk.platformProMatches() });
      void queryClient.invalidateQueries({ queryKey: qk.proMatches() });
    },
  });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(lib ?? [])]
      .sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key))
      .filter(
        (m) =>
          !needle ||
          `${m.date} ${m.home} ${m.away} ${m.competition ?? ''} ${m.gender} ${m.format}`
            .toLowerCase()
            .includes(needle),
      );
  }, [lib, q]);
  const balls = (lib ?? []).filter((m) => m.hasBalls).length;

  return (
    <Card
      title="In the library"
      sub={
        lib
          ? `${lib.length} match${lib.length === 1 ? '' : 'es'}, ${balls} with ball by ball.`
          : undefined
      }
    >
      {loading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the library…</p>
      ) : failed ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          Could not load the library — refresh to retry.
        </p>
      ) : !lib?.length ? (
        <EmptyState
          icon={Icon.Doc}
          title="No matches yet"
          sub="Drop the first exports above. Every union's professional-team scouting reads from here."
        />
      ) : (
        <>
          <input
            className="field-input ml-search"
            placeholder="Search date, team, competition…"
            aria-label="Search the library"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="tbl-w">
            <table className="tbl ml-tbl" aria-label="Matches in the library">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Match</th>
                  <th className="hide-narrow">Competition</th>
                  <th>Records</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.key}>
                    <td className="num">{m.date}</td>
                    <td>
                      <strong>
                        {shortTeam(m.home)} v {shortTeam(m.away)}
                      </strong>
                      <div className="ml-sub">
                        {m.gender === 'women' ? 'Women' : 'Men'} · {m.format}
                        {m.result ? ` · ${m.result}` : ''}
                      </div>
                    </td>
                    <td className="hide-narrow">{m.competition ?? '—'}</td>
                    <td>
                      <span className="ml-recs">
                        {m.sources.some((s) => s.kind === 'scorecard') && (
                          <Pill tone="navy">Scorecard</Pill>
                        )}
                        {m.hasBalls && <Pill tone="teal">Ball by ball</Pill>}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {confirm === m.key ? (
                        <span className="ml-confirm">
                          <Btn
                            tone="ink"
                            size="sm"
                            disabled={del.isPending}
                            onClick={() => del.mutate(m.key)}
                          >
                            Remove
                          </Btn>
                          <Btn tone="ghost" size="sm" onClick={() => setConfirm(null)}>
                            Keep
                          </Btn>
                        </span>
                      ) : (
                        <Btn
                          tone="ghost"
                          size="sm"
                          aria-label={`Remove ${m.date} ${shortTeam(m.home)} v ${shortTeam(m.away)}`}
                          onClick={() => setConfirm(m.key)}
                        >
                          Remove
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
