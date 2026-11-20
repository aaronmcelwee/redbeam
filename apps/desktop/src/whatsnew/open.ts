/**
 * Open What's new from anywhere — Settings › About, the prompt — without
 * those places knowing where the dialog is mounted. The window-level host in
 * WhatsNew.tsx listens for this.
 */
export const WHATS_NEW_EVENT = 'redbeam:whats-new'

export function openWhatsNew(): void {
  window.dispatchEvent(new CustomEvent(WHATS_NEW_EVENT))
}
