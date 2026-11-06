/**
 * Fires the school WebApp's family-invite API calls from inside an admin page, so two pages can hit
 * the RestApi at the same instant (N1: same-second regenerate / resend). No selectors, no page objects.
 *
 * The WebApp attaches its own auth to every API call; the helper copies the headers of the drawer's
 * status GET (armed before the drawer opens) and reuses them for the POST. Headers stay in memory and
 * inside the page; they are never logged.
 */
import type { Page, Request } from '@playwright/test';

export interface InviteApiHandle {
  page: Page;
  statusUrl: string;
  headers: Record<string, string>;
}

export interface InviteApiResult {
  status: number;
  code: string | null;
  /** Browser clock (ms) when fetch() was called. */
  firedAt: number;
}

const KEEP = /^(authorization|accept|x-[a-z0-9-]+)$/i;

/** Arm BEFORE opening the student's drawer; resolves with the drawer's status GET. */
export function captureInviteApi(page: Page, studentId: string): Promise<InviteApiHandle> {
  const path = `/students/${encodeURIComponent(studentId)}/parent-family`;
  return page
    .waitForRequest((r: Request) => r.method() === 'GET' && new URL(r.url()).pathname.endsWith(path), { timeout: 60_000 })
    .then(async (r) => {
      const all = await r.allHeaders();
      const headers = Object.fromEntries(Object.entries(all).filter(([k]) => KEEP.test(k)));
      return { page, statusUrl: r.url().split('?')[0], headers };
    });
}

/**
 * POSTs `{statusUrl}/{action}` from the page at browser-clock time `atMs` (busy-waits the last ms so
 * two pages fire within ~1 ms of each other).
 */
export function fireInviteAction(api: InviteApiHandle, action: 'invite' | 'regenerate' | 'resend' | 'cancel', atMs: number): Promise<InviteApiResult> {
  return api.page.evaluate(
    async ({ url, headers, atMs }) => {
      const wait = atMs - Date.now();
      if (wait > 20) await new Promise((r) => setTimeout(r, wait - 15));
      while (Date.now() < atMs) { /* spin */ }
      const firedAt = Date.now();
      const res = await fetch(url, { method: 'POST', headers, credentials: 'include' });
      let code: string | null = null;
      try { code = ((await res.json()) as { code?: string | null }).code ?? null; } catch { /* no body */ }
      return { status: res.status, code, firedAt };
    },
    { url: `${api.statusUrl}/${action}`, headers: api.headers, atMs },
  );
}

/** Reads the drawer's status (code, message) through the API, as the drawer itself does. */
export function readInviteStatus(api: InviteApiHandle): Promise<{ status: number; code: string | null; message: string | null }> {
  return api.page.evaluate(
    async ({ url, headers }) => {
      const res = await fetch(url, { headers, credentials: 'include' });
      const body = (await res.json().catch(() => ({}))) as { code?: string | null; message?: string | null };
      return { status: res.status, code: body.code ?? null, message: body.message ?? null };
    },
    { url: api.statusUrl, headers: api.headers },
  );
}
