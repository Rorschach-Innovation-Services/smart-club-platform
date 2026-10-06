/**
 * Toast copy for the admin "Send reminder" result (POST /admin/clearances/:cid/remind → 200).
 * Nothing delivered splits two ways: every channel `skipped` means the source chair has no usable
 * contact on file; any `failed` means a good contact the provider couldn't reach right now (the
 * server released the day's claim, so a retry later the same day works).
 */
export function clearanceRemindToast(
  fromClubName: string,
  results: Array<{ status: string }> | undefined,
): { message: string; tone?: 'warn' } {
  const list = results ?? [];
  if (list.some((r) => r.status === 'sent')) {
    return { message: `Reminder sent to ${fromClubName}'s chair` };
  }
  if (list.some((r) => r.status === 'failed')) {
    return {
      message: `No reminder delivered — sending to ${fromClubName}'s chair failed; try again shortly`,
      tone: 'warn',
    };
  }
  return {
    message: `No reminder delivered — ${fromClubName} has no usable chair contact on file`,
    tone: 'warn',
  };
}
