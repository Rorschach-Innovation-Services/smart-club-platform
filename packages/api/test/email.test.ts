/**
 * Unit tests for the reg-link email content builder (notify/email.ts) — the one
 * email body that used to hardcode "the Dolphins cohort" / "The Dolphins office".
 * regLinkEmailContent is pure (no SES/env), so bodies are asserted directly; the
 * dolphins-flavored strings must come ONLY from the org copy passed in.
 *
 * Run with the API package's test runner (tsx --test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  regLinkEmailContent,
  type RegLinkEmailInput,
  veteransRequestEmailContent,
  veteransRequestResolvedEmailContent,
} from '../src/notify/email.js';
import { orgCopy } from '../src/branding.js';

const baseInput = (org: RegLinkEmailInput['org']): RegLinkEmailInput => ({
  to: 'chair@example.com',
  chairName: 'Sam',
  clubName: 'Glenwood CC',
  season: '2026/27',
  link: 'https://sharks.example.com/register/glenwood?t=tok',
  org,
});

describe('regLinkEmailContent · tenant-parametrized copy', () => {
  test('a non-dolphins org never mentions Dolphins (text + html)', () => {
    const org = orgCopy({
      tenant: 'sharks',
      branding: {
        name: 'The Sharks',
        title: 'Sharks Smart Club',
        logoUrl: '/l.png',
        colors: {},
        copy: { orgShort: 'Sharks', office: 'Sharks office', cohortName: 'Sharks cohort' },
      },
    });
    const { subject, text, html } = regLinkEmailContent(baseInput(org));
    for (const body of [subject, text, html]) {
      assert.ok(!/dolphins/i.test(body), `expected no "Dolphins" in: ${body}`);
    }
    assert.match(text, /the Sharks cohort\./);
    assert.match(text, /The Sharks office$/);
    assert.match(html, /the Sharks cohort\./);
    assert.match(html, /<p>The Sharks office<\/p>/);
  });

  test('a missing tenant config degrades to neutral platform copy', () => {
    const { text, html } = regLinkEmailContent(baseInput(orgCopy(null)));
    assert.ok(!/dolphins/i.test(text));
    assert.match(text, /the Smart Club cohort\./);
    assert.match(text, /The Smart Club office$/);
    assert.ok(!/dolphins/i.test(html));
  });

  test('dolphins org copy reproduces the dolphins wording', () => {
    const org = orgCopy({
      tenant: 'dolphins',
      branding: {
        name: 'Hollywoodbets Dolphins',
        title: 'Dolphins Pipeline',
        logoUrl: '/l.png',
        colors: {},
        copy: {
          orgShort: 'Dolphins',
          office: 'Dolphins office',
          cohortName: 'Dolphins Pipeline cohort',
        },
      },
    });
    const { text, html } = regLinkEmailContent(baseInput(org));
    assert.match(text, /your roster and the Dolphins Pipeline cohort\./);
    assert.match(text, /The Dolphins office$/);
    assert.match(html, /<p>The Dolphins office<\/p>/);
  });

  test('org copy is HTML-escaped in the html body but verbatim in text', () => {
    const { text, html } = regLinkEmailContent(
      baseInput({ name: 'A & B', office: 'A & B office', cohort: 'A & B cohort' }),
    );
    assert.match(text, /the A & B cohort\./);
    assert.match(html, /the A &amp; B cohort\./);
    assert.match(html, /<p>The A &amp; B office<\/p>/);
  });

  test('tutorials section still renders below the org copy when present', () => {
    const input = {
      ...baseInput({ name: 'Sharks', office: 'Sharks office', cohort: 'Sharks cohort' }),
      tutorials: {
        pageUrl: 'https://sharks.example.com/tutorials',
        videos: [{ title: 'Getting started', url: 'https://cdn.example.com/v1.mp4' }],
      },
    };
    const { text, html } = regLinkEmailContent(input);
    assert.match(text, /Getting started: https:\/\/cdn\.example\.com\/v1\.mp4/);
    assert.match(html, /watch them all here/);
  });
});

describe('veteransRequestEmailContent (ADR 0013)', () => {
  const base = {
    to: 'chair@primary.example',
    chairName: 'Sam',
    veteransClubName: 'Vets United',
    playerName: 'Alex Player',
    primaryClubName: 'Glenwood CC',
  };

  test('addresses the primary chair and names both clubs + the player', () => {
    const { subject, text, html } = veteransRequestEmailContent(base);
    assert.match(subject, /Veterans request — Alex Player/);
    assert.match(text, /Vets United has asked to register Alex Player/);
    assert.match(text, /Glenwood CC/);
    assert.match(html, /confirm this in your club portal/);
  });

  test('includes and escapes a note when present; omits it otherwise', () => {
    const withNote = veteransRequestEmailContent({ ...base, note: 'plays <b>well</b> & fast' });
    assert.match(withNote.text, /Note from Vets United: plays <b>well<\/b> & fast/);
    assert.match(withNote.html, /plays &lt;b&gt;well&lt;\/b&gt; &amp; fast/);
    assert.ok(!withNote.html.includes('<b>well</b>'), 'raw note HTML must be escaped');

    const noNote = veteransRequestEmailContent(base);
    assert.ok(!/Note from/.test(noNote.text));
  });
});

describe('veteransRequestResolvedEmailContent (ADR 0013)', () => {
  const base = {
    to: 'chair@vets.example',
    chairName: 'Jo',
    veteransClubName: 'Vets United',
    playerName: 'Alex Player',
    primaryClubName: 'Glenwood CC',
  };

  test('accepted copy confirms the affiliation and that the player stays put', () => {
    const { subject, text } = veteransRequestResolvedEmailContent({ ...base, outcome: 'accepted' });
    assert.match(subject, /Veterans request accepted — Alex Player/);
    assert.match(text, /Glenwood CC has confirmed Alex Player's affiliation to Vets United/);
    assert.match(text, /stay registered at Glenwood CC/);
  });

  test('declined copy states the decline and carries an escaped reason', () => {
    const { subject, text, html } = veteransRequestResolvedEmailContent({
      ...base,
      outcome: 'declined',
      reason: 'not eligible <this> year',
    });
    assert.match(subject, /Veterans request declined — Alex Player/);
    assert.match(text, /Glenwood CC has declined the request to register Alex Player/);
    assert.match(text, /Reason: not eligible <this> year/);
    assert.match(html, /not eligible &lt;this&gt; year/);
  });
});
