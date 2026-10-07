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
  postponementOpenedEmailContent,
  postponementCounteredEmailContent,
  postponementAgreedEmailContent,
  postponementAdminFinalEmailContent,
  postponementDeclinedEmailContent,
  fixtureReminderEmailContent,
  fixtureReminderDateLabel,
  clearancePendingEmailContent,
  clearanceResolvedEmailContent,
  clearanceReopenedSourceEmailContent,
  clearanceReopenedDestEmailContent,
  clearanceOpenedDestEmailContent,
  clearanceOpenedAdminEmailContent,
  clearanceOpenedAdminSummaryEmailContent,
  clearanceAutoRejectedAdminEmailContent,
  clearanceReminderDigestEmailContent,
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

  test('club noun defaults to "club" (cricket wording unchanged)', () => {
    const { text, html } = regLinkEmailContent(baseInput(orgCopy(null)));
    assert.match(text, /register straight into the club:/);
    assert.match(html, /register straight into the club:<\/p>/);
  });

  test('a school vertical says "school" instead of "club"', () => {
    const { text, html } = regLinkEmailContent(baseInput({ ...orgCopy(null), club: 'school' }));
    assert.match(text, /register straight into the school:/);
    assert.match(html, /register straight into the school:<\/p>/);
    assert.ok(!/into the club/.test(text));
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

describe('postponement notices (ADR 0015)', () => {
  const fixtureLabel = 'Glenwood CC v Northlands CC · Premier League';

  test('opened: names both dates, the reason, and escapes HTML', () => {
    const { subject, text, html } = postponementOpenedEmailContent({
      chairName: 'Pat',
      requestingClubName: 'Glenwood CC',
      fixtureLabel,
      originalDate: '2026-11-07',
      originalTime: '10:00',
      proposedDate: '2026-11-14',
      reason: 'Ground <flooded>',
    });
    assert.equal(subject, `Postponement request — ${fixtureLabel}`);
    assert.match(text, /^Hello Pat,/);
    assert.match(text, /scheduled for Sat 2026-11-07 at 10:00, to Sat 2026-11-14\./);
    assert.match(text, /Reason from Glenwood CC: Ground <flooded>/);
    assert.match(html, /Ground &lt;flooded&gt;/);
  });

  test('a time that is not passed in never appears (withheld times stay hidden)', () => {
    const { text } = postponementCounteredEmailContent({
      chairName: '',
      counteringClubName: 'Northlands CC',
      fixtureLabel,
      originalDate: '2026-11-07',
      proposedDate: '2026-11-21',
    });
    assert.match(text, /^Hello there,/);
    assert.doesNotMatch(text, / at \d\d:\d\d/);
  });

  test('agreed / admin-final / declined / withdrawn copy', () => {
    assert.match(
      postponementAgreedEmailContent({
        chairName: 'Pat',
        fixtureLabel,
        originalDate: '2026-11-07',
        newDate: '2026-11-14',
        newTime: '13:00',
      }).text,
      /is now on Sat 2026-11-14 at 13:00/,
    );
    const ruling = postponementAdminFinalEmailContent({
      chairName: 'Pat',
      fixtureLabel,
      originalDate: '2026-11-07',
      newDate: '2026-11-28',
      venueName: 'Kings Park',
    });
    assert.match(ruling.text, /Venue: Kings Park/);
    assert.match(ruling.text, /Please acknowledge this ruling in your club portal\./);
    assert.match(
      postponementDeclinedEmailContent({
        chairName: 'Pat',
        actingClubName: 'Northlands CC',
        fixtureLabel,
        originalDate: '2026-11-07',
        outcome: 'declined',
      }).text,
      /Northlands CC has declined the request to postpone .*stays on Sat 2026-11-07\./,
    );
    assert.equal(
      postponementDeclinedEmailContent({
        chairName: 'Pat',
        actingClubName: 'Glenwood CC',
        fixtureLabel,
        originalDate: '2026-11-07',
        outcome: 'withdrawn',
      }).subject,
      `Postponement withdrawn — ${fixtureLabel}`,
    );
  });
});

describe('fixture reminder email', () => {
  const base = {
    chairName: 'Sam',
    clubName: 'Glenwood CC',
    dateLabel: fixtureReminderDateLabel('2026-11-07'),
  };

  test('date label carries the weekday', () => {
    assert.equal(fixtureReminderDateLabel('2026-11-07'), 'Sat 2026-11-07');
  });

  test('lists each fixture with opponent, home/away, revealed time and venue, and the portal link', () => {
    const { subject, text, html } = fixtureReminderEmailContent({
      ...base,
      portalLink: 'https://glenwood.example.com',
      fixtures: [
        {
          seriesName: 'Premier League',
          sideName: 'Glenwood CC',
          opponentName: 'Northlands <CC>',
          isHome: true,
          time: '10:00',
          venue: 'Glenwood Oval',
        },
        {
          seriesName: 'Reserve League',
          sideName: 'Glenwood B',
          opponentName: 'Crusaders',
          isHome: false,
        },
      ],
    });
    assert.equal(subject, 'Fixture reminder — Glenwood CC · Sat 2026-11-07');
    assert.match(text, /Hello Sam/);
    assert.match(text, /has 2 fixtures on Sat 2026-11-07/);
    assert.match(
      text,
      /Premier League · Glenwood CC vs Northlands <CC> \(Home\) · 10:00 · Glenwood Oval/,
    );
    assert.match(text, /Reserve League · Glenwood B vs Crusaders \(Away\)\n/);
    assert.match(text, /club portal: https:\/\/glenwood\.example\.com/);
    // HTML escapes user-supplied names and links the portal.
    assert.match(html, /Northlands &lt;CC&gt;/);
    assert.doesNotMatch(html, /Northlands <CC>/);
    assert.match(html, /<a href="https:\/\/glenwood\.example\.com">/);
  });

  test('a time or venue that is not passed in never appears, and no link when the tenant has none', () => {
    const { text, html } = fixtureReminderEmailContent({
      ...base,
      fixtures: [
        { seriesName: 'Premier League', sideName: 'Glenwood CC', opponentName: 'X', isHome: true },
      ],
    });
    assert.match(text, /has a fixture on/);
    assert.match(text, /Premier League · Glenwood CC vs X \(Home\)\n/);
    assert.doesNotMatch(text, /\d{2}:\d{2}/);
    assert.match(text, /details in your club portal\./);
    assert.doesNotMatch(html, /<a /);
  });
});

describe("captainsReportDueEmailContent · the captain's report link", () => {
  const input = {
    to: 'captain@example.com',
    recipientName: 'Sanele',
    recipientKind: 'captain' as const,
    clubName: 'Umzinto CC',
    matchLine: 'Umzinto CC v African Warriors',
    matchDateText: 'Sun 4 Oct 2026',
    expiresText: 'Sunday, 11 Oct',
    link: 'https://club.example.com/r/tok.sig',
    orgName: 'Dolphins',
  };

  test('says the draft can be saved, it submits once, and when the link expires', async () => {
    const { captainsReportDueEmailContent } = await import('../src/notify/email.js');
    const { text, html } = captainsReportDueEmailContent(input);
    assert.match(text, /You can save a draft and submit once\. Link expires Sunday, 11 Oct\./);
    assert.match(html, /You can save a draft and submit once\. Link expires Sunday, 11 Oct\./);
    assert.doesNotMatch(text, /works once/);
  });

  test('a reminder says so in the subject and the body', async () => {
    const { captainsReportDueEmailContent } = await import('../src/notify/email.js');
    const { subject, text } = captainsReportDueEmailContent({ ...input, reminder: true });
    assert.match(subject, /^Reminder: /);
    assert.match(text, /still open/);
  });

  test('a forwarded report names the chair who sent it on', async () => {
    const { captainsReportDueEmailContent } = await import('../src/notify/email.js');
    const { text } = captainsReportDueEmailContent({ ...input, forwardedBy: 'Uma Chair' });
    assert.match(text, /Uma Chair asked you to complete/);
  });
});

describe('clearance notice deep links', () => {
  const CHAIR_LINK = 'https://glenwood.example.com/club/c1/clearances?clearance=clr-1&x=<y>';
  const ADMIN_LINK = 'https://glenwood.example.com/admin/clearances?clearance=clr-1';
  const LIST_LINK = 'https://glenwood.example.com/admin/clearances';
  const chairCopy = {
    to: 'chair@example.com',
    chairName: 'Sam',
    fromClubName: 'Northlands CC',
    playerName: 'Thabo Nkosi',
    toClubName: 'Glenwood CC',
  };
  const adminCopy = {
    to: 'admin@example.com',
    fromClubName: 'Northlands CC',
    playerName: 'Thabo Nkosi',
    toClubName: 'Glenwood CC',
  };

  type Content = { subject: string; text: string; html: string };
  /** Every chair builder, rendered with and without its link. */
  const chairBuilders: Array<[string, (link?: string) => Content]> = [
    ['pending', (portalLink) => clearancePendingEmailContent({ ...chairCopy, portalLink })],
    [
      'resolved (approved)',
      (portalLink) =>
        clearanceResolvedEmailContent({ ...chairCopy, outcome: 'approved', portalLink }),
    ],
    [
      'resolved (rejected, with reason)',
      (portalLink) =>
        clearanceResolvedEmailContent({
          ...chairCopy,
          outcome: 'rejected',
          reason: 'unpaid fees',
          rejectOutcome: 'source-reactivated',
          portalLink,
        }),
    ],
    [
      'reopened (source)',
      (portalLink) => clearanceReopenedSourceEmailContent({ ...chairCopy, portalLink }),
    ],
    [
      'reopened (destination)',
      (portalLink) => clearanceReopenedDestEmailContent({ ...chairCopy, portalLink }),
    ],
    [
      'opened (destination)',
      (portalLink) => clearanceOpenedDestEmailContent({ ...chairCopy, portalLink }),
    ],
  ];

  for (const [name, build] of chairBuilders) {
    test(`${name}: the link rides in text + HTML, right before the union-office fallback`, () => {
      const { text, html } = build(CHAIR_LINK);
      assert.ok(text.includes(`Review it here: ${CHAIR_LINK}\n\n`));
      const escaped =
        'https://glenwood.example.com/club/c1/clearances?clearance=clr-1&amp;x=&lt;y&gt;';
      assert.ok(html.includes(`<p>Review it here: <a href="${escaped}">${escaped}</a></p>`));
      assert.ok(!html.includes('<y>'), 'the link is HTML-escaped');
      // The escape hatch for a chair with no portal login always stays, after the link.
      assert.ok(
        text.indexOf('Review it here') < text.indexOf('contact your union office'),
        'link line first, then the union-office fallback',
      );
    });

    test(`${name}: with no link the body is unchanged — no link line, no anchor`, () => {
      const without = build();
      assert.ok(!without.text.includes('Review it here'));
      assert.ok(!without.html.includes('<a '));
      assert.match(without.text, /contact your union office/);
      // Adding a link only inserts the link paragraph: strip it and the bodies match exactly.
      const withLink = build(CHAIR_LINK);
      assert.equal(withLink.text.replace(`Review it here: ${CHAIR_LINK}\n\n`, ''), without.text);
      assert.equal(
        withLink.html.replace(/<p>Review it here: <a [^]*?<\/a><\/p>/, ''),
        without.html,
      );
      assert.equal(withLink.subject, without.subject);
    });
  }

  test('pending: the extracted builder keeps the original pending copy', () => {
    const { subject, text, html } = clearancePendingEmailContent({
      ...chairCopy,
      playerName: 'Thabo\nNkosi',
    });
    assert.equal(subject, 'Clearance pending — Thabo Nkosi');
    assert.equal(
      text,
      'Hello Sam,\n\n' +
        "A player clearance is awaiting Northlands CC's review: Thabo\nNkosi has applied to join " +
        'Glenwood CC and needs a clearance from your club.\n\n' +
        'Please have this reviewed and approved or rejected in your club portal, or contact your ' +
        'union office if you have any questions.\n\n' +
        'Thank you,\nThe union office',
    );
    assert.match(html, /<strong>Northlands CC<\/strong>'s review/);
  });

  test('admin opened: per-clearance admin link, none without', () => {
    const withLink = clearanceOpenedAdminEmailContent({ ...adminCopy, adminLink: ADMIN_LINK });
    assert.ok(withLink.text.includes(`Review it here: ${ADMIN_LINK}\n\nThe union office platform`));
    assert.ok(withLink.html.includes(`<a href="${ADMIN_LINK}">${ADMIN_LINK}</a>`));
    const without = clearanceOpenedAdminEmailContent(adminCopy);
    assert.ok(!without.text.includes('Review it here'));
    assert.ok(!without.html.includes('<a '));
    assert.match(
      without.text,
      /listed under Clearances in the admin console\.\n\nThe union office platform$/,
    );
  });

  test('admin auto-rejected: per-clearance admin link after the reason, none without', () => {
    const base = { ...adminCopy, reason: 'transfers are closed' };
    const withLink = clearanceAutoRejectedAdminEmailContent({ ...base, adminLink: ADMIN_LINK });
    assert.ok(
      withLink.text.includes(
        `Reason: transfers are closed\n\nReview it here: ${ADMIN_LINK}\n\nThe union office platform`,
      ),
    );
    assert.ok(withLink.html.includes(`<a href="${ADMIN_LINK}">`));
    const without = clearanceAutoRejectedAdminEmailContent(base);
    assert.ok(!without.text.includes('Review it here'));
    assert.ok(!without.html.includes('<a '));
    assert.match(without.text, /Reason: transfers are closed\n\nThe union office platform$/);
  });

  test('admin summary: links the clearances LIST, none without', () => {
    const base = {
      toClubName: 'Glenwood CC',
      clearances: [{ playerName: 'Thabo Nkosi', fromClubName: 'Northlands CC' }],
    };
    const withLink = clearanceOpenedAdminSummaryEmailContent({ ...base, adminLink: LIST_LINK });
    assert.ok(
      withLink.text.includes(`Review them here: ${LIST_LINK}\n\nThe union office platform`),
    );
    assert.ok(withLink.html.includes(`<a href="${LIST_LINK}">${LIST_LINK}</a>`));
    const without = clearanceOpenedAdminSummaryEmailContent(base);
    assert.ok(!without.text.includes('Review them here'));
    assert.ok(!without.html.includes('<a '));
  });

  test('reminder digest: each line carries its own admin deep link; lines without one stay plain', () => {
    const line = {
      id: 'clr-1',
      playerName: 'Thabo Nkosi',
      fromClubName: 'Northlands CC',
      toClubName: 'Glenwood CC',
      daysPending: 9,
    };
    const withLinks = clearanceReminderDigestEmailContent({
      orgName: 'Dolphins',
      nudged: [{ ...line, adminLink: ADMIN_LINK }],
      chairless: [
        {
          ...line,
          id: 'clr-2',
          fromClubName: 'Off System CC',
          adminLink: 'https://glenwood.example.com/admin/clearances?clearance=clr-2',
        },
      ],
    });
    assert.ok(
      withLinks.text.includes(
        `- Thabo Nkosi: Northlands CC → Glenwood CC (9 days) — ${ADMIN_LINK}`,
      ),
    );
    assert.ok(
      withLinks.text.includes(
        '- Thabo Nkosi: Off System CC → Glenwood CC (9 days) — https://glenwood.example.com/admin/clearances?clearance=clr-2',
      ),
    );
    assert.ok(withLinks.html.includes(`(9 days) — <a href="${ADMIN_LINK}">Review</a></li>`));

    const without = clearanceReminderDigestEmailContent({
      orgName: 'Dolphins',
      nudged: [line],
      chairless: [],
    });
    assert.ok(without.text.includes('- Thabo Nkosi: Northlands CC → Glenwood CC (9 days)\n'));
    assert.ok(!without.html.includes('<a '));
  });
});
