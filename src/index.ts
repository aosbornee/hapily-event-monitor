import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { config } from 'dotenv';
import pLimit from 'p-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

import { scrapeCompanyPosts } from './lib/apify.js';
import { searchWeb, readPage, resolveRedirect } from './lib/jina.js';
import { confirmEvent, extractFromSearchResults, extractFromPage } from './lib/llm.js';
import { pushToClay } from './lib/clay.js';
import { log } from './lib/log.js';
import type { Account, Event, LinkedInPost } from './types.js';

const ACCOUNTS_JSON = resolve(__dirname, '..', 'accounts.json');
const OUTPUT_DIR = resolve(__dirname, '..', 'output');

const EVENT_KEYWORDS = [
  'booth', 'expo', 'trade show', 'tradeshow', 'conference', 'summit',
  'keynote', 'attendees', 'exhibiting', 'day 1', 'day 2',
  'kicks off', 'kicked off', 'panel', 'sponsor', 'in-person',
  'on-site', 'happy hour', 'meetup', 'gala',
  'speaking at', 'presenting at', 'join us at',
];

const APIFY_BATCH_SIZE = 250;
const LLM_CONCURRENCY = 100;
const DEFAULT_BATCH_CONCURRENCY = 10;

// ── Helpers ───────────────────────────────────────────────────────────

function loadAccounts(limit?: number): Account[] {
  const raw = readFileSync(ACCOUNTS_JSON, 'utf-8');
  const all = JSON.parse(raw) as Account[];
  return limit ? all.slice(0, limit) : all;
}

const CSV_HEADERS: (keyof Event)[] = [
  'company_linkedin', 'name', 'date', 'type', 'is_paid', 'price',
  'source_url', 'registration_url', 'detected_at', 'source',
];

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""').replace(/\n/g, ' ')}"`;
  }
  return val;
}

function writeCSVHeader(path: string) {
  writeFileSync(path, CSV_HEADERS.join(',') + '\n');
}

function appendEventsCSV(events: Event[], path: string) {
  const lines = events.map(e =>
    CSV_HEADERS.map(h => csvEscape(String(e[h] == null || e[h] === 'null' ? '' : e[h]))).join(','),
  );
  if (lines.length > 0) {
    appendFileSync(path, lines.join('\n') + '\n');
  }
}

function keywordFilter(posts: LinkedInPost[]): LinkedInPost[] {
  return posts.filter(p => {
    const content = (p.content ?? '').toLowerCase();
    return content && EVENT_KEYWORDS.some(kw => content.includes(kw));
  });
}

function normalizeLinkedIn(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}

function getCompanyLinkedIn(post: LinkedInPost): string {
  const raw = post.query?.targetUrl ?? post.author?.linkedinUrl ?? '';
  return normalizeLinkedIn(raw);
}

function extractUrlsFromContent(content: string): string[] {
  return content.split(/\s+/).filter(w => w.startsWith('http')).map(w => w.replace(/[.,;:)]+$/, ''));
}

// ── Per-hit processing (no dedup here — done after) ──────────────────

type RawEvent = Event & { _dedupKey: string; _companyName: string };
let _verbose = false;

async function processHit(post: LinkedInPost): Promise<RawEvent | null> {
  const companyName = post.author?.name ?? 'Unknown';
  const companyLinkedIn = getCompanyLinkedIn(post);
  const postDate = post.postedAt?.date?.slice(0, 10) ?? '';
  const content = post.content ?? '';

  let result;
  try {
    result = await confirmEvent(companyName, postDate, content);
  } catch (err) {
    log('pipeline', `LLM error for ${companyName}: ${err}`);
    return null;
  }

  if (_verbose) {
    const snippet = content.slice(0, 200).replace(/\n/g, ' ');
    if (result.is_event && result.name) {
      log('qa', `✓ ${companyName} | ${result.type} | "${result.name}" | date=${result.date ?? 'none'} | paid=${result.is_paid}\n     POST: ${snippet}`);
    } else {
      log('qa', `✗ ${companyName} | NOT EVENT\n     POST: ${snippet}`);
    }
  }

  if (!result.is_event || !result.name) return null;

  const eventType = result.type === 'hosting' ? 'hosting' : 'attending';

  const event: RawEvent = {
    company_linkedin: companyLinkedIn,
    name: result.name,
    date: result.date ?? null,
    type: eventType,
    is_paid: result.is_paid ?? false,
    price: null,
    source_url: post.linkedinUrl ?? '',
    registration_url: result.event_url ?? null,
    detected_at: new Date().toISOString().slice(0, 10),
    source: 'linkedin',
    _dedupKey: `${companyLinkedIn}|${result.name}`.toLowerCase(),
    _companyName: companyName,
  };

  // Step 2: If URL in post, resolve + scrape event page
  const postUrls = extractUrlsFromContent(content);
  const eventUrl = result.event_url ?? postUrls[0] ?? null;

  if (eventUrl) {
    log('pipeline', `  Resolving URL: ${eventUrl.slice(0, 80)}`);
    try {
      const resolved = await resolveRedirect(eventUrl);
      event.registration_url = resolved;
      const pageContent = await readPage(resolved);
      if (pageContent.length > 50) {
        const pageData = await extractFromPage(pageContent);
        if (pageData.date) event.date = pageData.date;
        if (pageData.is_paid != null) event.is_paid = pageData.is_paid;
        if (pageData.price) event.price = pageData.price;
      }
    } catch (err) {
      log('pipeline', `  URL resolution failed: ${err}`);
    }
  }

  // Step 3: If still no date, Google search fallback
  if (!event.date) {
    const year = new Date().getFullYear();
    const eventNameTruncated = result.name.slice(0, 60).replace(/[^\w\s]/g, '');
    const query = `"${eventNameTruncated}" ${year}`;
    log('pipeline', `  Google search fallback: ${query}`);

    try {
      const searchResults = await searchWeb(query);
      if (searchResults.length > 0) {
        const extracted = await extractFromSearchResults(result.name, searchResults);
        if (extracted.date) event.date = extracted.date;
        if (extracted.best_url && !event.registration_url) event.registration_url = extracted.best_url;
        if (extracted.is_paid != null) event.is_paid = extracted.is_paid;
        if (extracted.price) event.price = extracted.price;

        if (!event.date && extracted.best_url) {
          log('pipeline', `  Fetching event page: ${extracted.best_url.slice(0, 80)}`);
          const pageContent = await readPage(extracted.best_url);
          if (pageContent.length > 50) {
            const pageData = await extractFromPage(pageContent);
            if (pageData.date) event.date = pageData.date;
            if (pageData.is_paid != null) event.is_paid = pageData.is_paid;
            if (pageData.price) event.price = pageData.price;
          }
        }
      }
    } catch (err) {
      log('pipeline', `  Search fallback failed: ${err}`);
    }
  }

  if (event.date) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const eventDate = new Date(event.date);
    if (eventDate < sixMonthsAgo) {
      log('pipeline', `✗ ${companyName} — ${event.name} dropped (date ${event.date} is >6 months old)`);
      return null;
    }
  }

  log('pipeline', `→ ${companyName} — ${event.name} (${event.type}) [${event.date ?? 'no date'}]`);
  return event;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : undefined;
  const daysBack = args.includes('--days-back') ? parseInt(args[args.indexOf('--days-back') + 1]) : 14;
  const offset = args.includes('--offset') ? parseInt(args[args.indexOf('--offset') + 1]) : 0;
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const outputArg = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
  const batchConcurrency = args.includes('--batch-concurrency')
    ? parseInt(args[args.indexOf('--batch-concurrency') + 1])
    : DEFAULT_BATCH_CONCURRENCY;

  const sinceDate = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);

  _verbose = verbose;
  log('main', `Loading accounts from ${ACCOUNTS_JSON}`);
  const accounts = loadAccounts(limit);
  log('main', `Loaded ${accounts.length} accounts with LinkedIn URLs`);

  if (dryRun) {
    const batchCount = Math.ceil(accounts.length / APIFY_BATCH_SIZE);
    const maxCost = accounts.length * 10 * 0.002;
    log('main', `DRY RUN — ${accounts.length} companies, ${batchCount} batches, ${batchConcurrency} concurrent`);
    log('main', `Posts since: ${sinceDate}`);
    log('main', `Estimated Apify cost: $${maxCost.toFixed(2)} (max)`);
    return;
  }

  const clayWebhookUrl = process.env.CLAY_WEBHOOK_URL;
  if (clayWebhookUrl) {
    log('main', `Clay webhook configured — will push events per batch`);
  } else {
    log('main', `No CLAY_WEBHOOK_URL set — CSV output only`);
  }

  const allEvents: Event[] = [];
  const seen = new Set<string>();
  const llmLimit = pLimit(LLM_CONCURRENCY);
  const batchLimit = pLimit(batchConcurrency);
  let completedBatches = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = outputArg ?? resolve(OUTPUT_DIR, `linkedin-events-${new Date().toISOString().slice(0, 10)}.csv`);

  if (offset > 0) {
    log('main', `Resuming from batch ${offset + 1} — appending to existing CSV`);
  } else {
    writeCSVHeader(outputPath);
  }

  const batches: Account[][] = [];
  for (let i = 0; i < accounts.length; i += APIFY_BATCH_SIZE) {
    batches.push(accounts.slice(i, i + APIFY_BATCH_SIZE));
  }

  const activeBatches = batches.slice(offset);

  log('main', `Processing ${activeBatches.length} batches of up to ${APIFY_BATCH_SIZE} companies`);
  log('main', `Batch concurrency: ${batchConcurrency}, LLM concurrency: ${LLM_CONCURRENCY}`);
  log('main', `Posts since: ${sinceDate}`);
  log('main', `Output: ${outputPath}`);

  async function processBatch(batch: Account[], batchIndex: number): Promise<void> {
    const batchNum = offset + batchIndex + 1;
    const targetUrls = batch.map(a => a.linkedin);

    // Build lookup from LinkedIn URL → account metadata
    const accountLookup = new Map<string, Account>();
    for (const a of batch) {
      accountLookup.set(normalizeLinkedIn(a.linkedin), a);
    }
    log('main', `Batch ${batchNum}/${batches.length}: ${targetUrls.length} companies...`);

    let posts: LinkedInPost[];
    try {
      posts = await scrapeCompanyPosts(targetUrls, { maxPosts: 10, postedLimitDate: sinceDate });
    } catch (err) {
      log('main', `Batch ${batchNum} Apify failed: ${err}`);
      return;
    }
    log('main', `  Batch ${batchNum}: ${posts.length} posts pulled`);

    const hits = keywordFilter(posts);
    if (hits.length === 0) {
      completedBatches++;
      log('main', `  Batch ${batchNum}: 0 keyword hits — done (${completedBatches}/${activeBatches.length})`);
      return;
    }
    log('main', `  Batch ${batchNum}: ${hits.length} keyword hits`);

    const rawResults = await Promise.all(
      hits.map(hit => llmLimit(() => processHit(hit))),
    );

    const batchEvents: Event[] = [];
    for (const raw of rawResults) {
      if (!raw) continue;
      if (seen.has(raw._dedupKey)) continue;
      seen.add(raw._dedupKey);
      const { _dedupKey, _companyName, ...event } = raw;
      allEvents.push(event);
      batchEvents.push(event);
    }

    appendEventsCSV(batchEvents, outputPath);

    if (clayWebhookUrl && batchEvents.length > 0) {
      const clayRows = batchEvents.map(e => {
        const account = accountLookup.get(e.company_linkedin);
        return {
          name: account?.name ?? '',
          domain: account?.domain ?? '',
          company_linkedin: e.company_linkedin,
          event_name: e.name,
          event_date: e.date ?? '',
          event_type: e.type,
          is_paid: e.is_paid,
          price: e.price ?? '',
          source_url: e.source_url,
          event_url: e.registration_url ?? '',
          detected_at: e.detected_at,
        };
      });
      await pushToClay(clayWebhookUrl, clayRows);
    }

    completedBatches++;
    log('main', `  Batch ${batchNum}: ${batchEvents.length} new events — done (${completedBatches}/${activeBatches.length}, ${allEvents.length} total)`);
  }

  await Promise.all(
    activeBatches.map((batch, i) => batchLimit(() => processBatch(batch, i))),
  );

  log('main', `\n${'='.repeat(50)}`);
  log('main', `RESULTS: ${allEvents.length} events from ${accounts.length} companies (deduped)`);

  if (allEvents.length === 0) {
    log('main', 'No events found.');
    return;
  }

  log('main', `Final output: ${outputPath}`);

  const withDate = allEvents.filter(e => e.date).length;
  const hosting = allEvents.filter(e => e.type === 'hosting').length;
  const paid = allEvents.filter(e => e.is_paid).length;
  log('main', `Stats: ${withDate}/${allEvents.length} have dates, ${hosting} hosting, ${allEvents.length - hosting} attending, ${paid} paid`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
