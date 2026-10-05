# Hapily Event Monitor

This script scrapes LinkedIn company pages for event activity and pushes discovered events into a Clay table. You are helping Nikki (or whoever is running this) operate it.

## Before first run

1. Make sure `.env` exists with all four keys filled in (copy from `.env.example` if needed):
   - `APIFY_TOKEN` - for LinkedIn scraping
   - `JINA_API_KEY` - for web reading and search
   - `OPENAI_API_KEY` - for event classification
   - `CLAY_WEBHOOK_URL` - the Clay table's webhook URL
   - `HUBSPOT_TOKEN` - (optional, for pulling accounts from HubSpot instead of the static JSON)

2. Run `npm install` if `node_modules/` doesn't exist.

3. **Test with a small batch first.** Do NOT run the full account list on the first go. Start with 10 companies to make sure everything is wired up:
   ```bash
   npm start -- --limit 10
   ```
   Check the Clay table to confirm rows arrived with the right fields (name, domain, event_name, event_date, event_type, event_url, etc.)

## How to run it

```bash
# Standard run (last 14 days, full account list)
npm start

# Limit to N companies (for testing or smaller runs)
npm start -- --limit 100

# Pull accounts from a HubSpot company list instead of accounts.json
npm start -- --hubspot-list <LIST_ID>

# Look back further than 14 days
npm start -- --days-back 30

# Dry run (shows what it would do, no API calls)
npm start -- --dry-run

# Verbose mode (shows every classification decision for QA)
npm start -- --verbose --limit 50

# Resume from a specific batch if it stopped halfway
npm start -- --offset 3
```

## How long does it take?

The script processes companies in batches of 250, running 10 batches concurrently.

| Account list size | Estimated time |
|-------------------|---------------|
| 250 | ~4 minutes |
| 1,000 | ~5 minutes |
| 5,000 | ~12 minutes |
| 10,000 | ~20 minutes |
| 27,000 | ~45-55 minutes |

If the script stops halfway, nothing is lost. Events are saved to CSV and pushed to Clay per batch as it runs. Use `--offset` to resume from where it left off.

Make sure your laptop doesn't sleep while it runs. On macOS, run this in a separate terminal:
```bash
caffeinate -dims
```

## Schedule

This is meant to be run **every 2 weeks**. The default `--days-back 14` looks at the last 14 days of LinkedIn posts, so running it biweekly covers everything without overlap.

## Account list

There are two ways to feed accounts into the script:

### Option 1: HubSpot list (recommended)
Create a company list in HubSpot with your target accounts. Pass the list ID:
```bash
npm start -- --hubspot-list 123
```
This pulls companies dynamically so the list stays current as you add/remove accounts in HubSpot. The list ID is in the HubSpot URL when you open the list.

### Option 2: Static JSON file
Drop an `accounts.json` file in the repo root. Format:
```json
[
  { "name": "Acme Corp", "domain": "acme.com", "linkedin": "https://www.linkedin.com/company/acme" }
]
```
The script defaults to this if no `--hubspot-list` is passed.

## What it pushes to Clay

Each event row sent to the Clay webhook contains:

| Field | Description |
|-------|-------------|
| `name` | Company name |
| `domain` | Company domain |
| `company_linkedin` | Company LinkedIn URL |
| `event_name` | Name of the event |
| `event_date` | Date (YYYY-MM-DD) |
| `event_type` | `hosting` or `attending` |
| `is_paid` | Whether the event charges admission |
| `price` | Price if detected |
| `source_url` | LinkedIn post URL where we found it |
| `event_url` | Event registration/info page |
| `detected_at` | When the script found it |

## If something goes wrong

- **Apify errors on specific companies**: Bad LinkedIn URLs in the account list. The script skips them and moves on.
- **Rate limiting**: The script handles retries automatically. If you see persistent rate limits, let Andrew know.
- **Missing fields in Clay**: Check that the webhook URL is correct and the Clay table has a webhook source configured.

Questions? Ping Andrew.
