# Player Transfer Certificates — what they are and what to tell clients

**Audience:** client-facing team (non-technical). **Feature status:** built, on the dev site first, then production.

## The one-paragraph version

When a player's move between clubs is approved on the platform, the system now automatically produces an official Certificate of Player Transfer as a PDF. Every certificate carries a unique reference number and a QR code. Anyone holding the certificate, on screen or on paper, can scan the QR code and instantly see whether it is genuine, straight from our records. Nobody can fake one, and nobody can quietly edit one, because the certificate you hold is always checked against what we actually issued.

## Why this matters to clients

Unions and clubs have historically relied on signed paper clearance forms. Those get lost, disputed, and occasionally forged. This replaces them with a document that:

- **issues itself.** The moment a clearance is approved, the certificate exists. No office admin, no chasing signatures.
- **proves itself.** Scan the QR code (or type the reference at the verify page) and the union's own record appears: player, clubs, dates, and whether the certificate is still valid. If a certificate was altered, the details on the paper will not match the record. If it was invented, the reference simply will not exist.
- **holds up.** The approvals recorded on it name who approved, when, through their authenticated account. Under South African law (the ECT Act), that digital approval is a valid signature for this kind of document. No pen required, and the certificate says so on its face.

## What a client actually sees

1. A club requests a player's clearance; the releasing club approves it in their portal (or the union office overrides).
2. On the clearance, both clubs and the union office now see a **View certificate** button. It opens the PDF right in the browser, ready to download or print.
3. The certificate shows the player, both clubs, the effective date, the approval records, a reference like `SC-TRF-4H7Q2-9WXK3-M8NR5-T6E1D`, and a QR code labelled "Scan to verify".
4. Scanning the QR opens a public verification page: a green **VALID CERTIFICATE** banner and a checklist of the details to compare against the document in hand. There is also a box to type the reference manually, and an option to check an emailed PDF file against our records byte-for-byte.

The certificate is **not emailed or sent anywhere automatically**. It lives on the platform; the clubs and the union view, download, print or forward it themselves.

## Two looks, one choice per union

Each union picks one of two designs (we set this for them in the operator portal):

| | Classic | Confirmation |
|---|---|---|
| Feel | Traditional certificate: landscape, gold border, seal | Official form: portrait, tabulated records |
| Suits | Unions that frame and present | Unions that file and audit |

Both carry the union's logo and name automatically. The Confirmation design also prints the union's registration number, address, phone, website and email in the footer, so make sure we've captured those details for the union.

## Privacy (POPIA) — safe to explain confidently

- The **PDF itself** contains the player's full details, but only signed-in club and union staff can open it.
- The **public verification page** never shows the full ID number (it is masked, e.g. `94•••••••••089`) and never shows the date of birth. Someone who finds a reference number learns nothing sensitive.
- If a player or club exercises their right to erasure, their certificates and our verification records are deleted with them; the QR code then reports "not found".

## Things to know before a client asks

- **"Can the union cancel one?"** Yes. The union office can revoke a certificate (with a recorded reason). The verify page then shows a red REVOKED banner and stops showing the transfer's details. Revocation is permanent.
- **"What about our old, already-approved transfers?"** We can generate certificates for past approvals in bulk. Records that were bulk-imported from spreadsheets (rather than approved digitally) are excluded by default, because the certificate would claim a digital approval that never happened. If a union wants those too, they get honest wording: "Recorded from historical records — no digital approval on file".
- **"Old approvals don't name who approved."** Approvals made before this feature recorded a date but not a name. Their certificates say "Approving official not recorded" with the date. New approvals always name the official.
- **Union overrides.** When the union office approves a transfer over a club's head, the certificate says so plainly ("issued by the union office on the clubs' behalf"). When an override is only being used to clean up a junk record, the office unticks "Issue transfer certificate" and no certificate is created.
- **Approvals feel a touch slower.** Clicking approve now also builds the certificate, so the button works for a second or three ("Issuing certificate…"). Worth mentioning if a client comments.
- **The paper is only as good as the scan.** Our line to clients: *a certificate is genuine when the QR check says VALID **and** the details on the page match the details on the paper*. A photocopied genuine certificate with a doctored name still fails, because the checklist won't match.

## What we still handle internally

- Setting each union's template choice and contact details in the operator portal.
- Running the once-off back-issue for a union's historical approvals, when requested.
- The verification page lives on our platform address, so it keeps working even if a union later changes its own web domain.

## Quick reference

| Question | Answer |
|---|---|
| Who gets a certificate? | Every approved transfer (and union overrides, unless deliberately skipped) |
| Who can see the PDF? | Both clubs' staff and the union office, signed in |
| Who can verify one? | Anyone with the QR code or reference — no login |
| Can it be forged? | The reference space is effectively unguessable, and verification always answers from our records |
| Can it be edited? | Any edit shows up as a mismatch against the verify page, and a downloaded file can be checked byte-for-byte |
| Is it legally signed? | Yes — digital approvals by authenticated officials satisfy the ECT Act for this document type; the certificate states this |
