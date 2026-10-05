import OpenAI from 'openai';
import { z } from 'zod/v4';
import { LLMConfirmSchema, LLMSearchExtractSchema } from '../types.js';
import type { LLMConfirmResult, LLMSearchExtractResult } from '../types.js';
import { log as _log } from './log.js';
import type { SearchResult } from './jina.js';

const log = (msg: string, data?: Record<string, unknown>) => _log('llm', msg, data);

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return _client;
}

const MODEL_FAST = 'gpt-4o-mini';
const MODEL_REASONING = 'gpt-4o-mini';

function parseJSON<T>(raw: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(cleaned);

    // If the model returned event data with a name but forgot is_event, default it
    if (parsed.name && parsed.is_event === undefined) {
      parsed.is_event = true;
    }
    // Coerce price to string if model returned a number
    if (typeof parsed.price === 'number') {
      parsed.price = String(parsed.price);
    }

    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    log('validation_error', { issues: result.error.issues.map(i => i.message) });
    return fallback;
  } catch (err) {
    log('parse_error', { raw: raw.slice(0, 200), error: String(err) });
    return fallback;
  }
}

async function call(
  system: string,
  user: string,
  opts: { model?: string; maxTokens?: number; maxRetries?: number; jsonSchema?: Record<string, unknown> } = {},
): Promise<string> {
  const { model = MODEL_FAST, maxTokens = 2000, maxRetries = 3, jsonSchema } = opts;

  const responseFormat: Record<string, unknown> = jsonSchema
    ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: jsonSchema } }
    : { type: 'json_object' };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await getClient().chat.completions.create(
        {
          model,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: responseFormat as any,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        { timeout: 30_000 },
      );
      return resp.choices[0]?.message?.content ?? '{}';
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429 && attempt < maxRetries) {
        const backoff = 2 ** attempt * 1000;
        log('rate_limited', { attempt, backoff_ms: backoff });
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      if (jsonSchema && attempt < maxRetries) {
        log('schema_fallback', { attempt, error: String(err) });
        opts = { ...opts, jsonSchema: undefined };
        continue;
      }
      throw err;
    }
  }
  return '{}';
}

const CONFIRM_SYSTEM = `You analyze LinkedIn company posts to determine if the company is involved in a real, professional in-person event.

## What counts as an event
A professional event must have ALL of these: an industry or business purpose, a specific date or time period, and a physical venue or location. Examples: conferences, trade shows, summits, expos, industry forums, professional workshops.

## What does NOT count as an event
Reject the following — set is_event to false:
- Webinars, virtual events, online summits, livestreams
- Product launches, feature announcements, company news
- Hiring posts, job fairs (unless the company is exhibiting at an industry job fair)
- Case studies, blog posts, content pieces, video recordings of past events
- Happy hours, drinks events, lunches, dinners, and afterparties — ALWAYS reject these even when associated with or hosted alongside a professional conference or industry week (e.g. "Climate Week Happy Hour", "Post-Conference Drinks")
- Team outings, charity events, community events, food drives, volunteer days
- County fairs, state fairs, agricultural shows, car shows, horse shows
- Venue/space advertising
- Sporting events, entertainment events, competitions (e.g. strongman, golf classics, fun runs)
- If the event name is generic, a placeholder, or not a real name (e.g. "event name", "upcoming event"), reject it

## Hosting vs Attending
- "hosting" means the company organized, created, and runs the event. Strong signals: the event name contains the company name or brand, the company uses possessive language ("our annual summit", "we're hosting"), the company is issuing a call for speakers/proposals, the company is thanking sponsors (hosts solicit sponsorship), the event registration page is on the company's own domain
- "attending" means the company is participating in someone else's event. This includes: attending, sponsoring, exhibiting, speaking at, or having a booth at an event organized by another entity
- When in doubt, default to "attending" — misclassifying an attendee as a host is worse than the reverse

## Event name
The event name must be the PRIMARY subject of the post. If the post discusses one event but briefly mentions another event at the end (e.g. "see you next at X"), extract the primary event, not the passing mention.

## is_paid
- true if the post mentions tickets, pricing, registration fees, or paid admission
- false if clearly free (free registration, complimentary, no cost mentioned)
- false if unclear

## event_url
Extract any URL in the post that links to the event page (not the company's own website homepage, blog, or demo page).

Respond with JSON only.`;

export async function confirmEvent(
  company: string,
  postDate: string,
  content: string,
): Promise<LLMConfirmResult> {
  const user = `Company: "${company}"
Post date: ${postDate}

Post content:
${content.slice(0, 2000)}

Analyze this post. Is "${company}" involved in a real, professional in-person event?

If YES: {"is_event": true, "name": "event name", "date": "YYYY-MM-DD or null", "type": "attending or hosting", "is_paid": true/false, "event_url": "url or null"}
If NO: {"is_event": false}`;

  const confirmSchema = {
    type: 'object',
    properties: {
      is_event: { type: 'boolean' },
      name: { type: ['string', 'null'] },
      date: { type: ['string', 'null'] },
      type: { type: ['string', 'null'], enum: ['hosting', 'attending', null] },
      is_paid: { type: ['boolean', 'null'] },
      event_url: { type: ['string', 'null'] },
    },
    required: ['is_event', 'name', 'date', 'type', 'is_paid', 'event_url'],
    additionalProperties: false,
  };

  const raw = await call(CONFIRM_SYSTEM, user, { model: MODEL_REASONING, jsonSchema: confirmSchema });
  const fallback: LLMConfirmResult = { is_event: false };
  return parseJSON(raw, LLMConfirmSchema, fallback);
}

const SEARCH_EXTRACT_SYSTEM = `You extract event details from Google search results. Pick the best URL that is the official event page (not a blog post, news article, or LinkedIn post). Extract the date (YYYY-MM-DD start date only), location, and whether it's paid.

Rules for is_paid:
- true if the results mention tickets, pricing, registration fees, or paid admission
- false if it's clearly free (happy hour, meetup, customer dinner, free registration)
- null if unclear

Respond with JSON only.`;

export async function extractFromSearchResults(
  eventName: string,
  results: SearchResult[],
): Promise<LLMSearchExtractResult> {
  const formatted = results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
    .join('\n\n');

  const user = `Event: "${eventName}"

Search results:
${formatted}

Return:
{"best_url": "the official event page URL or null", "date": "YYYY-MM-DD or null", "location": "city, country or null", "is_paid": true/false/null, "price": "numeric amount only e.g. 999 or 1500. null if no specific dollar amount found. Never return descriptive text.", "confidence": "high/medium/low"}`;

  const searchSchema = {
    type: 'object',
    properties: {
      best_url: { type: ['string', 'null'] },
      date: { type: ['string', 'null'] },
      location: { type: ['string', 'null'] },
      is_paid: { type: ['boolean', 'null'] },
      price: { type: ['string', 'null'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['best_url', 'date', 'location', 'is_paid', 'price', 'confidence'],
    additionalProperties: false,
  };

  const raw = await call(SEARCH_EXTRACT_SYSTEM, user, { model: MODEL_REASONING, jsonSchema: searchSchema });
  const fallback: LLMSearchExtractResult = {
    best_url: null, date: null, location: null, is_paid: null, price: null, confidence: 'low',
  };
  return parseJSON(raw, LLMSearchExtractSchema, fallback);
}

const PAGE_EXTRACT_SYSTEM = `Extract event details from this webpage content.

Rules for is_paid:
- true if the page mentions tickets, pricing, registration fees, or paid admission
- false if it's clearly free (happy hour, meetup, customer dinner, free registration)
- null if unclear

Rules for price:
- Extract the numeric ticket/registration amount only (e.g. 999 or 1500)
- null if no specific dollar amount is listed
- Never return descriptive text, marketing copy, or discount descriptions

Return JSON only.`;

export async function extractFromPage(pageContent: string): Promise<{
  date: string | null;
  is_paid: boolean | null;
  price: string | null;
}> {
  const user = `${pageContent.slice(0, 6000)}

Return: {"date": "YYYY-MM-DD start date only or null", "is_paid": true/false/null, "price": "numeric amount only e.g. 999 or 1500. null if no specific dollar amount found."}`;

  const raw = await call(PAGE_EXTRACT_SYSTEM, user, { model: MODEL_REASONING, maxTokens: 500 });
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(cleaned);
  } catch {
    return { date: null, is_paid: null, price: null };
  }
}
