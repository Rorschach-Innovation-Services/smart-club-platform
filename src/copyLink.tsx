/* ─── Copy a server-signed link ───
 *
 * The admin "Copy link" action for squad requests and captain's reports. The link is a
 * stateless signed token the API mints on demand, so it is fetched ON CLICK and never cached.
 *
 * Safari gotcha: `clipboard.writeText` after an awaited fetch has lost the user-gesture window
 * and rejects. Handing `clipboard.write` a ClipboardItem whose blob is the fetch PROMISE keeps
 * the clipboard call inside the gesture. When the clipboard still refuses, a small dialog shows
 * the URL to copy by hand.
 */
import { useState, type ReactNode } from 'react';
import { Btn, Modal, ModalCancelBtn, useToast } from './atoms';
import { ApiError } from './api';

const errText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/** Start the clipboard write synchronously (inside the click), fed by the pending URL. */
function writeClipboard(url: Promise<string>): Promise<void> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip?.write && typeof ClipboardItem !== 'undefined')
    return clip.write([
      new ClipboardItem({
        'text/plain': url.then((u) => new Blob([u], { type: 'text/plain' })),
      }),
    ]);
  if (clip?.writeText) return url.then((u) => clip.writeText(u));
  return Promise.reject(new Error('Clipboard API unavailable'));
}

/**
 * `copy(id)` fetches the link and copies it; `node` renders the toast and the fallback dialog.
 * `note` follows "Link copied." — say when the copied link stops working.
 */
export function useCopyLink(
  fetchLink: (id: string) => Promise<{ url: string }>,
  note: string,
): { copy: (id: string) => void; busyId: string | null; node: ReactNode } {
  const [toast, toastNode] = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  function copy(id: string) {
    const url = fetchLink(id).then((r) => r.url);
    const clipped = writeClipboard(url);
    // A refused clipboard rejects before the fetch settles; absorb it now so the browser never
    // fires unhandledrejection (Sentry noise) — the later `await clipped` still rejects locally.
    clipped.catch(() => undefined);
    setBusyId(id);
    void (async () => {
      let resolved: string;
      try {
        resolved = await url;
      } catch (err) {
        // The clipboard write rejects with this same fetch failure — reported here, once.
        toast(errText(err, 'Could not get the link'), 'warn');
        setBusyId(null);
        return;
      }
      try {
        await clipped;
        toast(`Link copied. ${note}`);
      } catch (err) {
        console.warn('[copy-link] clipboard write refused; showing the link instead', err);
        setFallback(resolved);
      }
      setBusyId(null);
    })();
  }

  function copyFromDialog(url: string) {
    if (!navigator.clipboard?.writeText) {
      toast('Copying is blocked here — select the link and copy it by hand.', 'warn');
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => {
        setFallback(null);
        toast(`Link copied. ${note}`);
      },
      (err) => {
        console.warn('[copy-link] clipboard write refused in the dialog', err);
        toast('Copying is blocked here — select the link and copy it by hand.', 'warn');
      },
    );
  }

  const node = (
    <>
      {toastNode}
      {fallback && (
        <Modal
          eyebrow="Copy link"
          title="Copy this link"
          maxWidth={560}
          onClose={() => setFallback(null)}
          footer={
            <>
              <ModalCancelBtn tone="outline">Close</ModalCancelBtn>
              <Btn tone="ink" onClick={() => copyFromDialog(fallback)}>
                Copy
              </Btn>
            </>
          }
        >
          <p className="ph-desc">The browser blocked the automatic copy. {note}</p>
          <input
            className="input"
            readOnly
            value={fallback}
            aria-label="Link"
            style={{ width: '100%' }}
            onFocus={(e) => e.currentTarget.select()}
            autoFocus
          />
        </Modal>
      )}
    </>
  );
  return { copy, busyId, node };
}
