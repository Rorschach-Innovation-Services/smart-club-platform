import { describe, it, expect } from 'vitest';
import {
  auditActionSentence,
  auditActorDisplay,
  auditChangeRow,
  auditCountsText,
  auditFieldLabel,
  auditInProgress,
  auditOutcomeLabel,
  auditTargetLabel,
  auditTargetLine,
  auditTypeLabel,
  auditValueText,
  auditWhen,
  fallbackSentence,
} from './auditFormat';
import type { AuditEntry } from './types';

const entry = (action: string, targets: AuditEntry['targets'] = []) => ({ action, targets });

describe('auditActionSentence', () => {
  it('reads registry actions as plain sentences', () => {
    expect(auditActionSentence(entry('umpire.update'))).toBe('Edited umpire');
    expect(auditActionSentence(entry('scorer.merge'))).toBe('Merged scorer');
    expect(auditActionSentence(entry('tenant-config.update'))).toBe('Changed settings');
    expect(auditActionSentence(entry('player.erase'))).toBe("Erased a player's data");
    expect(auditActionSentence(entry('clearance.certificate.issue'))).toBe(
      'Issued a clearance certificate',
    );
  });

  it('names the link a link action is about', () => {
    const t = (type: string, id: string) => [{ type, id, op: 'copy', changeCount: 0 }];
    expect(auditActionSentence(entry('link.copy', t('captains-report', 'cr1')))).toBe(
      "Copied the captain's report link",
    );
    expect(auditActionSentence(entry('link.copy', t('squad-request', 'sq1')))).toBe(
      'Copied the squad link',
    );
    expect(auditActionSentence(entry('link.copy'))).toBe('Copied a document request link');
    expect(auditActionSentence(entry('link.mint', t('signup-link', 'club')))).toBe(
      'Created the club registration link',
    );
    expect(auditActionSentence(entry('link.revoke', t('signup-link', 'umpire')))).toBe(
      'Turned off the umpire registration link',
    );
    expect(auditActionSentence(entry('link.mint', t('club', 'c1')))).toBe(
      'Created a player registration link',
    );
  });

  it('falls back to a sentence built from the dotted name', () => {
    expect(fallbackSentence('umpire.update')).toBe('Edited umpire');
    expect(fallbackSentence('fixture-note.delete')).toBe('Deleted fixture note');
    expect(fallbackSentence('venue.closure.frobnicate')).toBe('Frobnicate venue closure');
    expect(fallbackSentence('reindex')).toBe('Reindex');
    expect(fallbackSentence('')).toBe('Made a change');
    expect(auditActionSentence(entry('widget.create'))).toBe('Added widget');
  });
});

describe('auditActorDisplay', () => {
  it('shows a signed-in person by email, flagging operators', () => {
    expect(
      auditActorDisplay({ kind: 'user', key: 's1', email: 'ann@x.org', via: 'console' }),
    ).toEqual({ label: 'ann@x.org', operator: false });
    expect(
      auditActorDisplay({
        kind: 'user',
        key: 's2',
        email: 'op@x.org',
        operator: true,
        via: 'platform',
      }),
    ).toEqual({ label: 'op@x.org', operator: true, detail: 'Operator portal' });
    expect(auditActorDisplay({ kind: 'user', key: 's3', via: 'console' }).label).toBe(
      'Unknown person',
    );
  });

  it('describes a link actor by who the link was for', () => {
    expect(
      auditActorDisplay({
        kind: 'link',
        key: 'link:captains-report:m1',
        via: 'captains-report',
        recipientKind: 'captain',
        recipientId: 'm1',
      }).label,
    ).toBe("Captain via captain's report link");
    expect(
      auditActorDisplay({
        kind: 'link',
        key: 'link:squad:m2',
        via: 'squad',
        recipientKind: 'chair',
      }).label,
    ).toBe('Club chair via squad link');
    expect(
      auditActorDisplay({
        kind: 'link',
        key: 'link:official-signup:shared',
        via: 'official-signup',
      }).label,
    ).toBe('Official via registration link');
    expect(
      auditActorDisplay({ kind: 'link', key: 'link:new-thing:shared', via: 'new-thing' }).label,
    ).toBe('Someone via new thing link');
  });

  it('calls an unattributed change System', () => {
    expect(auditActorDisplay({ kind: 'system', key: 'unattributed', via: 'unknown' }).label).toBe(
      'System',
    );
  });
});

describe('targets', () => {
  it('prefers the label, then a lookup, then a readable id', () => {
    expect(auditTargetLabel({ type: 'umpire', id: 'a-ngubane', label: 'A.Ngubane' })).toBe(
      'A.Ngubane',
    );
    expect(
      auditTargetLabel({ type: 'user', id: 'sub-1' }, (t, id) =>
        t === 'user' && id === 'sub-1' ? 'ann@x.org' : undefined,
      ),
    ).toBe('ann@x.org');
    expect(auditTargetLabel({ type: 'fixture-officials', id: 's1#f1' })).toBe('s1 · f1');
  });

  it('says Removed once an erasure stripped the record', () => {
    expect(auditTargetLabel({ type: 'player', id: '', scrubbed: true })).toBe('Removed');
    expect(auditTargetLabel({ type: 'umpire', id: 'x', scrubbed: true })).toBe('Removed');
  });

  it('prefixes the record type', () => {
    expect(
      auditTargetLine({
        type: 'umpire',
        id: 'u1',
        label: 'A.Ngubane',
        op: 'update',
        changeCount: 1,
      }),
    ).toBe('Umpire · A.Ngubane');
    expect(auditTypeLabel('tenant-config')).toBe('Settings');
    expect(auditTypeLabel('brand-new-type')).toBe('Brand new type');
  });
});

describe('changes', () => {
  it('shows old and new values', () => {
    expect(auditChangeRow({ field: 'displayName', from: 'Dende', to: 'Jooma' })).toEqual({
      field: 'Name',
      before: 'Dende',
      after: 'Jooma',
    });
  });

  it('hides masked values and marks erased ones', () => {
    expect(auditChangeRow({ field: 'idNumber', masked: true })).toEqual({
      field: 'ID number',
      note: 'Changed (hidden)',
    });
    expect(auditChangeRow({ field: 'fullName', scrubbed: true })).toEqual({
      field: 'Full name',
      note: 'Removed',
    });
  });

  it('joins arrays and spells out booleans and blanks', () => {
    expect(auditChangeRow({ field: 'clubIds', from: ['a', 'b'], to: [] })).toEqual({
      field: 'Clubs',
      before: 'a, b',
      after: '—',
    });
    expect(auditValueText(true)).toBe('Yes');
    expect(auditValueText(false)).toBe('No');
    expect(auditValueText(null)).toBe('—');
    expect(auditValueText(undefined)).toBe('—');
    expect(auditValueText(3)).toBe('3');
  });

  it('humanises field names it does not know', () => {
    expect(auditFieldLabel('fullName')).toBe('Full name');
    expect(auditFieldLabel('homeGround.venue')).toBe('Home ground › Venue');
    expect(auditFieldLabel('last_seen_at')).toBe('Last seen at');
  });
});

describe('outcome, counts and time', () => {
  it('labels only the outcomes that need a word', () => {
    const at = '2026-11-12T08:00:00.000Z';
    const now = Date.parse(at) + 5_000;
    expect(auditOutcomeLabel({ outcome: 'ok', at }, now)).toBeNull();
    expect(auditOutcomeLabel({ outcome: 'failed', at }, now)).toBe('Failed');
  });

  it('reads a started entry as in progress for its first minute, then as not finished', () => {
    const at = '2026-11-12T08:00:00.000Z';
    const t = Date.parse(at);
    expect(auditOutcomeLabel({ outcome: 'started', at }, t + 5_000)).toBe('In progress');
    expect(auditInProgress({ outcome: 'started', at }, t + 59_999)).toBe(true);
    expect(auditOutcomeLabel({ outcome: 'started', at }, t + 60_000)).toBe('Did not finish');
    expect(auditOutcomeLabel({ outcome: 'started', at }, t + 3_600_000)).toBe('Did not finish');
    expect(auditInProgress({ outcome: 'ok', at }, t + 1_000)).toBe(false);
  });

  it('lists non-zero counts', () => {
    expect(auditCountsText({ sent: 12, failed: 1, skipped: 0 })).toBe('12 sent, 1 failed');
    expect(auditCountsText(undefined)).toBe('');
  });

  it('gives relative and absolute time', () => {
    const at = '2026-11-12T08:00:00.000Z';
    const w = auditWhen(at, Date.parse('2026-11-12T10:30:00.000Z'));
    expect(w.relative).toBe('2h ago');
    expect(w.absolute).toMatch(/^12 Nov 2026, \d\d:\d\d$/);
  });
});
