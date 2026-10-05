import { log as _log } from './log.js';

const log = (msg: string, data?: Record<string, unknown>) => _log('jina', msg, data);

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const MAX_RETRIES = 3;
let lastCall = 0;
const MIN_INTERVAL = 143; // ~7 req/s

async function rateLimit() {
  const now = Date.now();
  const wait = lastCall + MIN_INTERVAL - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

export async function searchWeb(query: string, limit = 5): Promise<SearchResult[]> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) throw new Error('JINA_API_KEY not set');

  await rateLimit();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'X-Retain-Images': 'none',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (resp.status === 429) {
      const backoff = attempt * 2000;
      log('rate_limited', { query, attempt, backoff_ms: backoff });
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    if (!resp.ok) {
      log('search_error', { query, status: resp.status, attempt });
      return [];
    }

    const data = (await resp.json()) as {
      data?: Array<{ title?: string; url?: string; description?: string }>;
    };

    return (data.data ?? []).slice(0, limit).map(item => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
    }));
  }

  log('search_exhausted', { query });
  return [];
}

export async function readPage(url: string, maxChars = 8000): Promise<string> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) throw new Error('JINA_API_KEY not set');

  await rateLimit();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Engine': 'browser',
        'X-Return-Format': 'markdown',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (resp.status === 429) {
      const backoff = attempt * 2000;
      log('rate_limited', { url, attempt, backoff_ms: backoff });
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    if (!resp.ok) {
      log('read_error', { url, status: resp.status });
      return '';
    }

    const data = (await resp.json()) as { data?: { content?: string } };
    return (data.data?.content ?? '').slice(0, maxChars);
  }

  return '';
}

export async function resolveRedirect(url: string): Promise<string> {
  if (url.includes('lnkd.in/')) {
    return resolveLnkdUrl(url);
  }
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return resp.url;
  } catch {
    return url;
  }
}

async function resolveLnkdUrl(url: string): Promise<string> {
  const content = await readPage(url, 2000);
  if (!content) return url;
  const linkPattern = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(content)) !== null) {
    const href = match[2];
    if (!href.includes('linkedin.com') && !href.includes('licdn.com') && !href.includes('lnkd.in')) {
      return href;
    }
  }
  return url;
}
