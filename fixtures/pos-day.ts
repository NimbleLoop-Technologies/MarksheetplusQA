/** Open today's POS day with the PR 565 businessDate contract (local midnight as a UTC instant). */
import type { APIRequestContext, APIResponse } from '@playwright/test';

/** Pakistan (operational) calendar date `daysAgo` before today. */
export const pktDate = (daysAgo = 0) => {
  const d = new Date(Date.now() + 5 * 3600_000);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

/** Local midnight of a PKT calendar day, as a UTC instant. */
export const pktMidnightUtc = (day = pktDate()) => new Date(`${day}T00:00:00+05:00`).toISOString();

/** Open today's POS day. `businessDate` is required after PR 565. */
export async function openPosDay(api: APIRequestContext, openingFloat = 0): Promise<APIResponse> {
  return api.post('bookshop/point-of-sale/day', {
    data: { openingFloat, businessDate: pktMidnightUtc() },
  });
}
