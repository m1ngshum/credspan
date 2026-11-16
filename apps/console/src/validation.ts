export function displayNameError(value: string): string | undefined {
  if (!value.trim()) return 'Enter a display name.';
  if ([...value].length > 100) return 'Use 100 Unicode code points or fewer.';
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'Remove control characters from the display name.';
}

export async function copyCapability(value: string, write: (value: string) => Promise<void>): Promise<string> {
  try { await write(value); return 'Copied to clipboard.'; }
  catch { return 'Could not copy. Select the URL and copy it manually.'; }
}
