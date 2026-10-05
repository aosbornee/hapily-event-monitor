import { ApifyClient } from 'apify-client';
import { log as _log } from './log.js';
import type { LinkedInPost } from '../types.js';

const log = (msg: string, data?: Record<string, unknown>) => _log('apify', msg, data);

const ACTOR = 'harvestapi/linkedin-company-posts';

let _client: ApifyClient | null = null;

function getClient(): ApifyClient {
  if (!_client) {
    const token = process.env.APIFY_TOKEN;
    if (!token) throw new Error('APIFY_TOKEN not set');
    _client = new ApifyClient({ token });
  }
  return _client;
}

export async function scrapeCompanyPosts(
  targetUrls: string[],
  opts: { maxPosts?: number; postedLimitDate?: string } = {},
): Promise<LinkedInPost[]> {
  const { maxPosts = 10, postedLimitDate } = opts;

  log('starting_run', { companies: targetUrls.length, maxPosts, postedLimitDate });

  const run = await getClient().actor(ACTOR).call(
    {
      targetUrls,
      maxPosts,
      postedLimitDate,
      includeQuotePosts: false,
      includeReposts: false,
      scrapeReactions: false,
      scrapeComments: false,
    },
    { waitSecs: 300 },
  );

  if (run.status !== 'SUCCEEDED') {
    log('run_failed', { runId: run.id, status: run.status });
    return [];
  }

  const dataset = getClient().dataset(run.defaultDatasetId);
  const { items } = await dataset.listItems({ limit: 10_000, clean: true });

  log('dataset_fetched', { datasetId: run.defaultDatasetId, items: items.length });
  return items as unknown as LinkedInPost[];
}
