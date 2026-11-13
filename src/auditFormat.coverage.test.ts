/**
 * Coverage of the audit trail's display words against what the API records (ADR 0023): every
 * action the API can store reads as its own sentence, and every field name the API's diff
 * helpers record has a humanised label. Reads the API sources directly — the registry module
 * is imported (it has no dependencies), the rest is scanned as text — so a new action or field
 * on the API side fails here until it gets words.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  AUDIT_ACTION_SENTENCES,
  AUDIT_FIELD_LABELS,
  auditActionSentence,
  fallbackSentence,
} from './auditFormat';

const API_SRC = path.resolve(__dirname, '../packages/api/src');
const source = (file: string) => readFileSync(path.join(API_SRC, file), 'utf8');

/**
 * Actions deliberately left to the generic "Verb record" sentence, with why. Empty today: list
 * one here only when the fallback reads exactly as intended.
 */
const FALLBACK_OK: Record<string, string> = {};

/** Every action the API can store: registry actions, handler `auditSet({ action })` literals,
 * the dynamic official delete, and the series PATCH classifications. */
async function storedActions(): Promise<string[]> {
  // A non-literal specifier keeps the frontend type-check out of the API package.
  const registryPath = path.join(API_SRC, 'audit-routes.ts');
  const { AUDIT_ROUTES, isSkipped } = (await import(/* @vite-ignore */ registryPath)) as {
    AUDIT_ROUTES: Record<string, { action?: string; skip?: string }>;
    isSkipped: (s: unknown) => boolean;
  };
  const out = new Set<string>();
  for (const spec of Object.values(AUDIT_ROUTES)) if (!isSkipped(spec)) out.add(spec.action!);
  const index = source('index.ts');
  for (const m of index.matchAll(/auditSet\(\{\s*action:\s*'([^']+)'/g)) out.add(m[1]);
  // `auditSet({ action: \`${role}.delete\` })` — the official erase, per register.
  if (index.includes('auditSet({ action: `${role}.delete` })'))
    for (const role of ['umpire', 'scorer']) out.add(`${role}.delete`);
  const records = source('audit-records.ts');
  const patch = records.slice(records.indexOf('export function seriesPatchAction'));
  for (const m of patch.slice(0, patch.indexOf('\n}\n')).matchAll(/return '([^']+)'/g))
    out.add(m[1]);
  return [...out].sort();
}

/**
 * Every field name the API's diff helpers can record, from `audit-records.ts` (and the few
 * `field: '…'` literals `index.ts` records itself): the field-list constants, `field:` literals,
 * the view keys (`out.x =`, `out[\`…\`] =`, quoted `'a.b':` keys) and the pick lists of views.
 * A segment built at run time (`${…}`: a league key, a document key, an umpire card number) is
 * dynamic and not checked.
 */
function recordedFields(): string[] {
  const records = source('audit-records.ts');
  const out = new Set<string>();
  const literals = (s: string) => [...s.matchAll(/'([A-Za-z][\w.]*)'/g)].map((m) => m[1]);
  // Field-list constants (arrays and sets) and the views' pick lists.
  for (const m of records.matchAll(
    /const ([A-Z_]*(?:FIELDS|MASKED)[A-Z_]*)(?::[^=]+)? = (?:new Set\()?\[([\s\S]*?)\]/g,
  ))
    for (const f of literals(m[2])) out.add(f);
  for (const m of records.matchAll(/pick\([\s\S]*?\[([^\]]*)\]/g))
    for (const f of literals(m[1])) if (!/^[A-Z]/.test(f)) out.add(f);
  // `field: '…'` / `field: \`…\`` literals (index.ts too).
  for (const text of [records, source('index.ts')])
    for (const m of text.matchAll(/field:\s*(?:'([^']+)'|`([^`]+)`)/g)) out.add(m[1] ?? m[2]);
  // View keys.
  for (const m of records.matchAll(/out\.([A-Za-z]+) =/g)) out.add(m[1]);
  for (const m of records.matchAll(/out\[`([^`]+)`\] =/g)) out.add(m[1]);
  for (const m of records.matchAll(/^\s*'([a-z]+\.[a-z]+)':/gm)) out.add(m[1]);
  return [...out].sort();
}

/** True when every static segment of `field` (or the whole field) has a label. */
function labelled(field: string): boolean {
  // A segment built at run time (`${kind}Ref`) reads through its own label at run time.
  if (AUDIT_FIELD_LABELS[field]) return true;
  return field
    .replace(/\$\{[^}]*\}/g, '#')
    .split('.')
    .every((part) => part.includes('#') || /^\d+$/.test(part) || !!AUDIT_FIELD_LABELS[part]);
}

describe('audit display words cover what the API records', () => {
  it('every stored action reads as its own sentence', async () => {
    const actions = await storedActions();
    expect(actions.length).toBeGreaterThan(100);
    const missing = actions.filter(
      (a) => !AUDIT_ACTION_SENTENCES[a] && !a.startsWith('link.') && !(a in FALLBACK_OK),
    );
    expect(missing).toEqual([]);
    // Link actions read through their own sentences (never the generic fallback).
    for (const a of actions.filter((x) => x.startsWith('link.')))
      expect(auditActionSentence({ action: a, targets: [] })).not.toBe(fallbackSentence(a));
  });

  it('every field the diff helpers record has a label', () => {
    const fields = recordedFields();
    expect(fields).toEqual(expect.arrayContaining(['destClub', 'home', 'selection.players']));
    expect(fields.filter((f) => !labelled(f))).toEqual([]);
  });
});
