# Hapily Event Monitor

Scrapes LinkedIn company pages for event activity and pushes discovered events into a Clay table for enrichment and outbound campaign loading.

## For Claude Code

If you're reading this inside Claude Code, here's what you need to do to get this running.

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

Copy the example and fill in the keys:

```bash
cp .env.example .env
```

You need four keys:

| Variable | What it is | Where to get it |
|----------|-----------|-----------------|
| `APIFY_TOKEN` | Apify API token | [apify.com/account/integrations](https://apify.com/account/integrations) |
| `JINA_API_KEY` | Jina AI API key for web reading and search | [jina.ai](https://jina.ai) |
| `OPENAI_API_KEY` | OpenAI API key for LLM classification | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `CLAY_WEBHOOK_URL` | The Clay table's webhook URL | Clay table > Sources > Webhook |

Andrew should have already got you set up with accounts for these. If any are missing, ping Andrew.

### 3. Account list

`accounts.json` contains the target company list. Right now this is a static JSON file with ~27K HubSpot Enterprise Plus Marketing Hub accounts.

Format:
```json
[
  { "linkedin": "https://www.linkedin.com/company/example" },
  { "linkedin": "https://www.linkedin.com/company/another" }
]
```

**Future improvement:** This should be changed to pull directly from a HubSpot company list instead of a static file, so the target accounts stay dynamic as new companies are added or removed. For now, the static file works.

### 4. Run it

```bash
# Standard run (scrapes posts from the last 14 days, 10 concurrent batches)
npm start

# Look back further
npm start -- --days-back 30

# Test with a small batch first
npm start -- --limit 50

# Dry run (shows what it would do without making API calls)
npm start -- --dry-run

# Resume from a specific batch if it stopped halfway
npm start -- --offset 3

# Adjust batch concurrency (default 10, lower if you hit rate limits)
npm start -- --batch-concurrency 5
```

Run this every 2 weeks to keep the event data fresh.

## What happens when you run it

1. Loads the company LinkedIn URLs from `accounts.json`
2. Apify scrapes recent LinkedIn posts from each company (batches of 100)
3. Filters posts for event keywords (booth, expo, conference, summit, etc.)
4. An LLM classifies each hit: real event or not, hosting or attending, paid or free
5. Resolves any URLs in the post and scrapes event pages for dates and pricing
6. Falls back to Google search if no date is found
7. Saves results to `output/linkedin-events-YYYY-MM-DD.csv`
8. If `CLAY_WEBHOOK_URL` is set, pushes events to the Clay table per batch as it runs (so nothing is lost if the script stops halfway)

## Clay table setup

Create a Clay table with a webhook source. The script pushes these fields per event:

- `company_linkedin` - Company LinkedIn URL
- `event_name` - Name of the event
- `event_date` - Date (YYYY-MM-DD)
- `event_type` - `hosting` or `attending`
- `is_paid` - Whether the event charges admission
- `price` - Price if detected
- `source_url` - LinkedIn post URL where we found it
- `registration_url` - Event registration page
- `detected_at` - When the script found it

From there, add Clay enrichment columns to find contacts at those companies, enrich emails, and push to Instantly/HeyReach campaigns.

## Runtime and caffeinate

**This script takes 2-3 hours to run across the full 27K account list** with default concurrency (10 batches at a time). It processes in batches of 100 companies, running 10 Apify scrapes in parallel with 20 concurrent LLM calls across all batches.

Before you run it, make sure your laptop won't sleep. On macOS, run this in a separate terminal:

```bash
caffeinate -dims
```

This prevents your Mac from sleeping while the script runs. Kill it with Ctrl+C when the script finishes.

**Recommended workflow:** Start the script in the morning. It should finish within a few hours. If you hit rate limits, lower the concurrency with `--batch-concurrency 5`.

If it stops halfway (network blip, laptop restart, etc.), you won't lose progress. The CSV appends per batch, and Clay gets pushed per batch. Check the last batch number in the terminal output and resume with `--offset`:

```bash
# If it stopped at batch 150 of 270
npm start -- --offset 150
```

## Other notes

- CSV output is always saved locally as a backup, even when Clay push is enabled.
- The LLM runs through OpenAI using GPT-4o-mini for classification. It's cheap (fractions of a cent per company) and reliable with structured output.
- You can test with a small batch first (`--limit 50`) to make sure everything is wired up before running the full list.
