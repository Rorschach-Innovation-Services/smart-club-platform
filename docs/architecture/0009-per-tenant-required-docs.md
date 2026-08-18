# ADR 0009 — Per-tenant compliance-doc catalogue (`TenantConfig.requiredDocs`)

**Status:** Accepted (August 2026). Supersedes the doc-key freeze in ADR 0005: the
required-documents list is now per-tenant config, resolved with a read-time fallback to the
shared defaults exactly like `districts`.

## Context

ADR 0005 froze the compliance doc keys as shared constants (`REQUIRED_DOCS` in the frontend,
`DOC_KEYS`/`DOC_CONTENT_TYPES` on the server, plus a third copy in `buildClubFromSpec`) while
naming `TenantConfig.requiredDocs` as the intended future override. The second and third
clients made the freeze untenable: Titans' 2026-27 affiliation pack requires a different doc
set (league entry, assets register, health tracker, member database, committee, constitution,
AGM pack, financials, facility agreements) with different file formats (filled-in Excel
workbooks, not just PDF/Word), while dolphins keeps the original six. Every per-doc special
case was also a `key === '…'` branch (safeguarding multi-file, AGM meeting-booked, financials
unavailable, exco form-satisfied), so a per-tenant list forced those behaviors to become data.

## Decision

1. **`TenantConfig.requiredDocs?: RequiredDoc[]`** is the tenant's catalogue.
   `resolveRequiredDocs(cfg)` falls back to `DEFAULT_REQUIRED_DOCS` (today's six, expressed
   declaratively) when the field is absent — legacy tenants need no backfill and behave
   byte-identically. An explicit `[]` means "no compliance docs".
2. **Behavior is flags, not key literals.** `kind: 'file' | 'form'`, `multiFile` +
   `minFiles`/`maxFiles`, `allowUnavailable`, `allowMeetingBooked`, `allowCourseBooked`,
   `accepts` (pdf/doc/docx/xls/xlsx/ods), `archived`. The docMeta sentinel shapes are
   unchanged; only dispatch moved from key literals to flag lookups. Constraints (enforced by
   `validateRequiredDocs`): `allowMeetingBooked` is single-file-only, `allowCourseBooked` is
   multiFile-only, `allowUnavailable` is valid on both.
3. **`kind: 'form'` is restricted to the `exco` key in v1.** The only code path that satisfies
   a form doc is `POST /clubs/:id/exco`; any other form key would be an unsatisfiable
   requirement. The exco flip itself is gated on the ACTIVE catalogue defining `exco` with
   `kind === 'form'` — key presence alone is not enough, so a tenant using a file-based
   committee doc can never have a form save silently satisfy a required upload. Future
   generalization: form docs bind to a named platform feature.
4. **Write path mirrors `districts`** (ADR 0006 split): operator-only. `PUT /tenant/config`
   strips the field; `PUT /platform/tenants/:slug` validates then applies a **referrer delete
   guard** — removing a key that any club still holds data for (real upload docMeta OR a
   mark-compliant `docs[key] === true`) is a 409. `archived: true` is the sanctioned retire
   path: the entry keeps its key (never trips the guard), leaves completion counts, hides from
   upload flows, and keeps stored files viewable/deletable.
5. **Read path reverses ADR 0005's omission**: the catalogue rides the unauthenticated
   `GET /tenant` (and `/tenant/config`) — doc names/flags are as public as league and district
   names, and the rep portal reads only that payload. `matchHints` (operator bulk-intake
   classifier keywords) are stripped from both; they serve only on `/platform` routes.
6. **Existing-record union**: doc routes accept the resolved catalogue ∪ keys already stored
   on the club. New uploads require an active, non-form catalogue entry; view/replace/delete
   keep working for retired keys — that IS the cleanup path the delete guard points at. A
   retired key's multi-file behavior is derived from its stored meta shape (`files[]`).
   The **record** path (`PATCH /clubs/:id/docs/:key`) also rejects form-kind docs, matching
   the presign route: `assertOwnObjectKey` binds the tenant/club prefix but not the docKey
   segment, so without it a rep could presign under one key and record the file under `exco`,
   flipping a form doc without ever completing the form.
7. **The escape hatches are server-enforced, not advisory.** `PATCH /clubs/:id` rejects an
   `unavailable` / `meetingBooked` / `courseBooked` sentinel on a doc whose catalogue entry
   withholds the matching flag — otherwise they were UI-only and a rep or a stale tab could
   skip any requirement an operator deliberately made unskippable. Only a sentinel the patch
   INTRODUCES is rejected; one already stored rides through, so removing a flag from the
   catalogue can never leave a club that legitimately used it with an unsaveable record
   (every client spreads the existing docMeta). Clearing a stale sentinel is the admin revert
   path's job.
8. **Deletion is available for both doc shapes.** `DELETE /clubs/:id/docs/:key/file` handles
   single-file docs as well as multi-file ones. Upload can replace a single file but never
   remove it, so without this an archived single-file doc was a dead end — the promise that
   archived files stay "viewable/deletable", and the delete guard's advice to clear each
   club's record first, were both unsatisfiable for single-file keys, and the object stayed
   in the bucket forever. The objectKey must still be the one on record.

## Season rollover (recorded, not yet built)

`Club.docs`/`docMeta` are epoch-less, and a single-file re-upload deletes the prior S3 object.
When a tenant's next season needs fresh AGM minutes/financials, re-upload therefore destroys
the prior season's compliance record. The intended future answer is season-stamped docMeta (or
archive-on-replace into a `files[]`-style history), decided deliberately then — not
accidentally by the first 2027-28 reset. Until then, "reset for a new season" means an
operator/admin flow that clears flags, not a schema change.

## Consequences

- Adding a new key to a live catalogue instantly marks every previously-complete club
  incomplete. Accepted; the operator editor warns on add.
- Completion percentages (docCompletion, CQI p5, overallProgress) become per-tenant
  denominators. Default-list parity is pinned by tests so dolphins' numbers are unchanged.
- `GET /tenant` grows ~2-4 KB.
- The `DOC_KEYS`/`DOC_CONTENT_TYPES` exports remain only as deprecated shims for
  pre-catalogue scripts; route code never reads them.
- Doc-type retirement at scale routes through `archived`, or per-club cleanup + removal —
  there is deliberately no bulk force-delete.
- **Orphaned upload objects** (a presign + browser PUT whose record write never lands) are
  indistinguishable by key from committed ones — they share the `${tenant}/${clubId}/`
  prefix — so an S3 lifecycle expiry would delete live compliance documents. Deliberately
  NOT added. The correct cleanup is a reconciliation script diffing bucket keys under a
  tenant prefix against the clubs' `docMeta` (the `clubDocObjectKeys` helper already
  enumerates the record side); until one exists, the bulk-intake flow bounds the window by
  committing per club as each club's uploads finish.
