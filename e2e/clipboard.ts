/**
 * Shared clipboard helpers for the admin "Copy link" specs (admin-copy-link, doc-request).
 */
import { expect, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Click a row's Copy link and return the copied URL's path. Engine-tolerant: where the
 * clipboard accepts the write the toast shows and the URL is read back (from the clipboard,
 * or on WebKit from clipboardContext's write recorder); where it refuses, the fallback dialog
 * shows the URL instead.
 */
export async function copyFrom(page: Page, button: Locator) {
  await button.click();
  const toast = page.getByText(/^Link copied\./);
  const dialog = page.getByRole('dialog', { name: 'Copy this link' });
  await expect(toast.or(dialog)).toBeVisible();
  let url: string | null = null;
  if (await dialog.isVisible())
    url = await dialog.getByRole('textbox', { name: 'Link' }).inputValue();
  else
    url = await page.evaluate(
      async () =>
        (window as unknown as { __copied?: string }).__copied ??
        (await navigator.clipboard.readText()),
    );
  expect(url, 'a copied link, from the clipboard or the fallback dialog').toMatch(/^https?:\/\//);
  // The link base is the stack's configured public origin (locally :5173, not the e2e vite
  // :3201), so open the copied path on this app.
  return new URL(url!).pathname;
}

/**
 * A context whose clipboard is readable/writable where the engine supports the grant. WebKit
 * rejects these permission names (lazily, at newPage), so it gets no grant and a write
 * recorder instead; copyFrom still accepts the fallback dialog if the write is refused.
 */
export async function clipboardContext(browser: Browser) {
  const ctx = await browser.newContext();
  if (browser.browserType().name() === 'webkit') {
    // WebKit accepts the write but blocks readText without a real paste gesture: record what
    // the page writes (pass-through to the real clipboard) so copyFrom can read it back.
    await ctx.addInitScript(() => {
      const clip = navigator.clipboard;
      if (!clip) return;
      const w = window as unknown as { __copied?: string };
      const write = clip.write.bind(clip);
      const writeText = clip.writeText.bind(clip);
      clip.write = async (items: ClipboardItem[]) => {
        await write(items);
        w.__copied = await (await items[0].getType('text/plain')).text();
      };
      clip.writeText = async (text: string) => {
        await writeText(text);
        w.__copied = text;
      };
    });
    return ctx;
  }
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch (err) {
    console.warn('[copy-link e2e] clipboard permissions not granted; expecting the dialog', err);
  }
  return ctx;
}
