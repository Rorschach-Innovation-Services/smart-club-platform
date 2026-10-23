import { useRef, useState } from 'react';
import type { ReactNode, ChangeEvent } from 'react';
import { docAccept, docFormats, docMimeAllowed, resolveDocMime, extFromMime } from './data';
import { Btn, Icon } from './atoms';
import { getDocUploadUrl, uploadToPresigned } from './api';

/* ─── Compliance doc upload — presigned S3 PUT, then mark uploaded ─── */
interface DocUploadButtonProps {
  clubId: string;
  doc: { key: string; accepts?: string[] };
  label?: ReactNode;
  onUploaded: (key: string, meta: any) => unknown;
  toast: (msg: string, tone?: string) => void;
  variant?: string;
  buttonLabel?: ReactNode;
}
export function DocUploadButton({
  clubId,
  doc,
  label,
  onUploaded,
  toast,
  variant = 'button',
  buttonLabel,
}: DocUploadButtonProps) {
  const docKey = doc.key;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const isReplace = variant === 'link';
  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // file.type is often empty for .doc/.docx — resolve from the extension before
    // validating, or valid Word files get rejected / mislabelled as PDF.
    const mime = resolveDocMime(file);
    if (!docMimeAllowed(doc, mime)) {
      toast(
        `${docFormats(doc)
          .map((f) => f.toUpperCase())
          .join(', ')} files only`,
        'warn',
      );
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setBusy(true);
    try {
      if (import.meta.env.VITE_LOCAL_AUTH === '1') {
        // Local dev: no S3 — record the doc metadata without an actual upload.
        // The key must be unique per file: safeguarding stores several entries,
        // and a constant key would make every upload dedupe into the first.
        await onUploaded(docKey, {
          objectKey: `local/${docKey}-${crypto.randomUUID()}.${extFromMime(mime)}`,
          size: file.size,
          contentType: mime,
        });
      } else {
        // Use the server-echoed contentType for the PUT — it must match the
        // presigned ContentType exactly or S3 rejects the upload.
        const { uploadUrl, objectKey, contentType } = await getDocUploadUrl(clubId, docKey, mime);
        await uploadToPresigned(uploadUrl, file, contentType);
        await onUploaded(docKey, { objectKey, size: file.size, contentType });
      }
      // onUploaded rejects if the server-side record failed, so this only fires on
      // real success (and the failure toast is surfaced by the caller's withToast).
      toast(`${label} ${isReplace ? 'replaced' : 'uploaded'}`);
    } catch (err) {
      // The mark-uploaded step toasts its own error (err.alreadyToasted); only the
      // presigned-upload steps (getDocUploadUrl / uploadToPresigned) need surfacing here.
      if (err && !err.alreadyToasted) toast(err.message || 'Upload failed', 'warn');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={docAccept(doc)}
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      {isReplace ? (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => inputRef.current?.click()}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'var(--teal-deep)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Replacing…' : buttonLabel || 'Replace'}
        </button>
      ) : (
        <Btn tone="ink" size="sm" icon={Icon.Upload} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : buttonLabel || 'Upload'}
        </Btn>
      )}
    </>
  );
}
