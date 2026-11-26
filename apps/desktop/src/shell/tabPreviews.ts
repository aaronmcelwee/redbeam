/**
 * A small picture of the sheet each open PDF was last on, for its tab's
 * hover card (Shell.tsx `TabCard`).
 *
 * Kept for the window, not in a workspace: a Light tab that is not showing
 * has no workspace (lightTabs.ts), and its card still shows where it was
 * left. One JPEG data URL of about 20 KB per open file.
 */
const previews = new Map<string, string>()

export function setTabPreview(file: string, url: string): void {
  previews.set(file, url)
}

export function tabPreview(file: string): string | null {
  return previews.get(file) ?? null
}
