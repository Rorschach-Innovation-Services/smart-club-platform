/**
 * Public document-request page (`/d/<token>`): a player asked by the union office uploads a
 * document (ID document for now) without signing in. The token is the capability and names its
 * own tenant, so the page themes itself from the payload (like `/r/` and `/sq/`).
 *
 * A small standalone uploader on purpose — not DocUploadButton: that component is bound to the
 * authed `getDocUploadUrl`, needs a clubId and, under VITE_LOCAL_AUTH, fabricates metadata
 * without uploading. Here: file → token presign → PUT → complete.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Btn } from './atoms';
import { cleanLinkToken, fmtLinkExpiry } from './CaptainsReport';
import {
  ApiError,
  completeLinkedDocRequest,
  getDocRequestUploadUrl,
  getLinkedDocRequest,
  uploadToPresigned,
} from './api';
import { applyTheme } from './config';
import { resolveDocMime, docMimeAllowed } from './data';
import { qk } from './query';
import type { LinkedDocRequest } from './types';

/** The ID-document formats the API accepts (images or PDF). */
const ID_DOC = { accepts: ['jpg', 'jpeg', 'png', 'pdf'] };
const ID_DOC_ACCEPT = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';

function Done({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="cr-done">
      <div className="cr-done-title">{title}</div>
      <div className="cr-done-sub">{sub}</div>
    </div>
  );
}

function Uploader({
  token,
  data,
  onDone,
  onTerminal,
}: {
  token: string;
  data: LinkedDocRequest;
  onDone: () => void;
  onTerminal: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const mime = resolveDocMime(file);
    if (!docMimeAllowed(ID_DOC, mime)) {
      setError('Please choose a photo (JPG or PNG) or a PDF.');
      return;
    }
    if (file.size <= 0 || file.size > data.maxBytes) {
      setError(`The file must be under ${Math.round(data.maxBytes / (1024 * 1024))} MB.`);
      return;
    }
    setBusy(true);
    try {
      const signed = await getDocRequestUploadUrl(token, mime);
      await uploadToPresigned(signed.uploadUrl, file, signed.contentType);
      await completeLinkedDocRequest(token, signed.objectKey);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && [404, 409, 410].includes(err.status)) {
        onTerminal();
        return;
      }
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts — please try again in an hour.'
          : err instanceof ApiError && err.status === 400
            ? `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`
            : 'The upload did not go through. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="card" style={{ padding: 20 }}>
      <p style={{ marginTop: 0 }}>
        Take a clear photo of your {data.docName.toLowerCase()} or choose a scan (JPG, PNG or PDF,
        up to {Math.round(data.maxBytes / (1024 * 1024))} MB).
      </p>
      {error && (
        <div className="rp-validation" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={ID_DOC_ACCEPT}
        aria-label={`Upload your ${data.docName}`}
        style={{ display: 'none' }}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <Btn tone="teal" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Uploading…' : `Upload ${data.docName}`}
      </Btn>
    </div>
  );
}

export function DocRequestLinkPage() {
  const { token: rawToken = '' } = useParams();
  const token = cleanLinkToken(rawToken);
  const qc = useQueryClient();
  const [uploaded, setUploaded] = useState(false);
  const query = useQuery({
    queryKey: qk.linkedDocRequest(token),
    queryFn: () => getLinkedDocRequest(token),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: Infinity,
  });
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    applyTheme({
      colors: data.tenantBranding.colors,
      logoUrl: data.tenantBranding.logoUrl,
      title: `${data.tenantBranding.name} · Document upload`,
    });
  }, [data]);

  const err = query.error instanceof ApiError ? query.error : null;
  const kind = typeof err?.details?.kind === 'string' ? err.details.kind : undefined;

  let body: ReactNode;
  if (uploaded)
    body = (
      <Done
        title="Thank you — your document is uploaded"
        sub={
          data
            ? `${data.tenantBranding.name} has received your ${data.docName}. You can close this page.`
            : 'You can close this page.'
        }
      />
    );
  else if (query.isLoading) body = <div className="cr-section-sub">Loading…</div>;
  else if (err && (err.status === 410 || kind === 'expired'))
    body = (
      <Done
        title="This link has expired"
        sub="Please ask your club or union office to send you a new link."
      />
    );
  else if (err && err.status < 500)
    body = (
      <Done
        title="This link isn't valid"
        sub="It may have been replaced by a newer link, or your registration has changed. Please contact your club or union office."
      />
    );
  else if (!data)
    body = (
      <div className="cr-done">
        <div className="cr-done-title">Couldn't load this page</div>
        <div className="cr-done-sub">Check your connection and try again.</div>
        <div className="cr-done-actions">
          <Btn tone="teal" onClick={() => void query.refetch()}>
            Try again
          </Btn>
        </div>
      </div>
    );
  else if (data.state === 'completed')
    body = (
      <Done
        title="Already completed"
        sub={`Your ${data.docName} is already on file — there is nothing more to do.`}
      />
    );
  else
    body = (
      <>
        <div className="page-head">
          <div className="ph-left">
            <div className="ph-crumb">
              {data.clubName ? `${data.clubName} / ` : ''}Document upload
            </div>
            <h1 className="ph-title">
              Hi <em>{data.firstName}</em>
            </h1>
            <p className="ph-desc">
              {data.tenantBranding.name} has asked you to upload your {data.docName}. This link is
              personal to you and expires {fmtLinkExpiry(data.linkExpiresAt)}.
            </p>
          </div>
        </div>
        <Uploader
          token={token}
          data={data}
          onDone={() => setUploaded(true)}
          onTerminal={() => {
            // The request closed meanwhile (completed elsewhere, expired, or invalid):
            // reload and show that state.
            void qc.invalidateQueries({ queryKey: qk.linkedDocRequest(token) });
          }}
        />
      </>
    );

  return (
    <div className="cr-link-shell">
      <header className="cr-link-header">
        {data?.tenantBranding.logoUrl && <img src={data.tenantBranding.logoUrl} alt="" />}
        <strong>{data?.tenantBranding.name ?? 'Document upload'}</strong>
      </header>
      <main className="cr-link-main">{body}</main>
    </div>
  );
}
