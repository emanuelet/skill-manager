import { z } from 'zod';
import { getAnalyticsSnapshot } from '../../core/analytics-snapshot.js';
import { withToolHandler } from './helpers.js';

export const getAnalyticsSchema = z.object({
  stale_days: z.number().optional().describe('Threshold for stale detection (default: 30)'),
  unused_days: z.number().optional().describe('Threshold for unused detection (default: 30)'),
});

export const getAnalyticsHandler = withToolHandler(async (args: z.infer<typeof getAnalyticsSchema>) => {
  const staleDays = args.stale_days ?? 30;
  const unusedDays = args.unused_days ?? 30;
  return getAnalyticsSnapshot(staleDays, unusedDays);
});
