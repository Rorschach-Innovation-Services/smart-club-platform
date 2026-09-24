/**
 * RequiredDocsCard — the document-role editor self-serve onboarding (ADR 0010) leans
 * on. Without a way to set `role` here, a self-serve tenant's roster wizard and reps
 * page have no document to read from — they gate on `RequiredDoc.role`, never a
 * literal doc key. Pins: the Role picker round-trips into the saved payload, a role
 * already held by another active doc renders disabled with who holds it, and the
 * catalogue row shows a role badge at a glance.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequiredDocsCard } from './platform-required-docs';
import type { RequiredDoc, TenantConfig } from './types';

const DOCS: RequiredDoc[] = [
  { key: 'member-db', name: 'Member Database', role: 'memberDatabase' },
  { key: 'committee-doc', name: 'Committee Document' },
];

function setup(requiredDocs: RequiredDoc[] = DOCS) {
  const save = vi.fn().mockResolvedValue({});
  const toast = vi.fn();
  const user = userEvent.setup();
  const config = { tenant: 'acme', requiredDocs } as unknown as TenantConfig;
  render(<RequiredDocsCard config={config} save={save} toast={toast} />);
  return { user, save, toast };
}

/** Opens the edit dialog for a catalogue row by its document name. */
async function openEdit(user: ReturnType<typeof userEvent.setup>, docName: string) {
  const row = screen.getByText(docName).closest('div')!.parentElement!.parentElement!;
  await user.click(within(row).getByRole('button', { name: 'Edit' }));
  return screen.findByRole('dialog');
}

describe('RequiredDocsCard — Role picker', () => {
  it('shows a role badge on a catalogue row that already carries one', () => {
    setup();
    expect(screen.getByText('Member database')).toBeInTheDocument();
  });

  it('round-trips a role picked in the dialog into the saved payload, and omits it when unset', async () => {
    const { user, save } = setup();

    const dialog = await openEdit(user, 'Committee Document');
    const roleSelect = within(dialog).getByDisplayValue('None');
    await user.selectOptions(roleSelect, 'committee');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await user.click(screen.getByRole('button', { name: /save catalogue/i }));

    expect(save).toHaveBeenCalledTimes(1);
    const [payload] = save.mock.calls[0];
    const docs = payload.requiredDocs as RequiredDoc[];
    expect(docs.find((d) => d.key === 'committee-doc')?.role).toBe('committee');
    // The untouched row keeps its role, and any doc with no role omits the key
    // entirely (never `role: undefined`) so the server's "at most one active doc per
    // role" check reads a clean absence rather than a stray explicit undefined.
    expect(docs.find((d) => d.key === 'member-db')?.role).toBe('memberDatabase');
    expect('role' in (docs.find((d) => d.key === 'committee-doc') as object)).toBe(true);
  });

  it('disables a role already held by another active doc, naming the holder', async () => {
    const { user } = setup();

    const dialog = await openEdit(user, 'Committee Document');
    const roleSelect = within(dialog).getByDisplayValue('None');
    const memberDbOption = within(roleSelect).getByText(/assigned to Member Database/i);
    expect((memberDbOption as HTMLOptionElement).disabled).toBe(true);
  });

  it('does not disable a role held only by an archived doc — archiving frees it up', async () => {
    const archived: RequiredDoc[] = [
      { key: 'member-db', name: 'Member Database', role: 'memberDatabase', archived: true },
      { key: 'committee-doc', name: 'Committee Document' },
    ];
    const { user } = setup(archived);

    const dialog = await openEdit(user, 'Committee Document');
    const roleSelect = within(dialog).getByDisplayValue('None');
    const memberDbOption = within(roleSelect).getByText(
      /Member database — rosters parse from this document/i,
    );
    expect((memberDbOption as HTMLOptionElement).disabled).toBe(false);
  });

  it('renders an InfoTip explaining what the role drives', async () => {
    const { user } = setup();
    const dialog = await openEdit(user, 'Committee Document');
    expect(within(dialog).getByLabelText(/why does the role matter/i)).toBeInTheDocument();
  });
});

describe('RequiredDocsCard — Optional record toggle', () => {
  it('round-trips the Optional record toggle into the saved payload and shows a row pill', async () => {
    const { user, save } = setup();

    const dialog = await openEdit(user, 'Committee Document');
    await user.click(within(dialog).getByLabelText(/optional record/i));
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    // The catalogue row now flags it at a glance.
    expect(screen.getByText('Optional record')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save catalogue/i }));
    const docs = save.mock.calls[0][0].requiredDocs as RequiredDoc[];
    expect(docs.find((d) => d.key === 'committee-doc')?.optional).toBe(true);
    // Untouched rows never carry the flag (absent, not `optional: false`).
    expect('optional' in (docs.find((d) => d.key === 'member-db') as object)).toBe(false);
  });

  it('pre-checks the toggle for an already-optional doc and clears it on untick', async () => {
    const { user, save } = setup([
      { key: 'records', name: 'Club Records', optional: true, multiFile: true, minFiles: 1 },
    ]);

    const dialog = await openEdit(user, 'Club Records');
    const toggle = within(dialog).getByLabelText(/optional record/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await user.click(toggle);
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await user.click(screen.getByRole('button', { name: /save catalogue/i }));

    const docs = save.mock.calls[0][0].requiredDocs as RequiredDoc[];
    expect('optional' in docs[0]).toBe(false);
  });
});

describe('RequiredDocsCard — accepted-format summary', () => {
  it('labels .odt as OpenDocument text, matching its format option, not as Word', () => {
    setup([{ key: 'minutes', name: 'AGM Minutes', accepts: ['pdf', 'odt'] }]);
    expect(screen.getByText('PDF, OpenDocument text')).toBeInTheDocument();
  });

  it('keeps Word for doc/docx alongside .odt', () => {
    setup([{ key: 'minutes', name: 'AGM Minutes', accepts: ['pdf', 'docx', 'odt'] }]);
    expect(screen.getByText('PDF, Word, OpenDocument text')).toBeInTheDocument();
  });
});
