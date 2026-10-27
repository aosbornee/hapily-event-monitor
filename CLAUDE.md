# Hapily Event Monitor

This script scrapes LinkedIn company pages for event activity and pushes discovered events into a Clay table. You are helping Nikki (or whoever is running this) operate it.

## Before first run

1. Make sure `.env` exists with all four keys filled in (copy from `.env.example`):
   - `APIFY_TOKEN` - for LinkedIn scraping ([apify.com/account/integrations](https://apify.com/account/integrations))
   - `JINA_API_KEY` - for web reading and search ([jina.ai](https://jina.ai))
   - `OPENAI_API_KEY` - for event classification ([platform.openai.com/api-keys](https://platform.openai.com/api-keys))
   - `HUBSPOT_TOKEN` - HubSpot private app token for pulling the target account list

   The Clay webhook URL and HubSpot list ID are already hardcoded in `src/constants.ts`. You don't need to set those.

   Andrew should have already helped you get set up with these. If any are missing, ping Andrew.

2. Run `npm install` if `node_modules/` doesn't exist.

3. **Test with a small batch first.** Do NOT run the full account list on the first go. Start with 10 companies to make sure everything is wired up:
   ```bash
   npm start -- --limit 10
   ```
   Check the Clay table to confirm rows arrived with the right fields (name, domain, event_name, event_date, event_type, event_url, etc.)

## How to run it

```bash
# Standard run (last 14 days, full account list from HubSpot)
npm start

# Limit to N companies (for testing or smaller runs)
npm start -- --limit 100

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

## Schedule

This is meant to be run **every 2 weeks**. The default `--days-back 14` looks at the last 14 days of LinkedIn posts, so running it biweekly covers everything without overlap.

## Account list

The script pulls target accounts directly from HubSpot list 5277. It fetches company name, domain, and LinkedIn URL for each company in the list.

To change which companies get scraped, update the list in HubSpot. The script picks up changes automatically on each run. Add exclusions for open deals, customers, etc. in the HubSpot list filters.

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

## What happens downstream (in Clay)

Once events land in the Clay table, the rest of the pipeline runs inside Clay:

1. **Events arrive** via the webhook from this script. Each row is a company + event combination.

2. **Find contacts** at those companies. Clay's Find People enrichment searches for decision makers using the title keywords (field marketing, events, marketing ops, RevOps, sales leaders, etc.). Contacts are found fresh each time, so you always get current job titles and companies. No stale data.

3. **Enrich emails.** Clay runs the email waterfall (find + validate + host detection) on each contact.

4. **Route to the right campaign.** A formula column determines which Instantly campaign each contact should go into, based on:
   - **Persona** (Marketing, RevOps, Sales)
   - **Event type** (Attending vs Hosting)
   - **Paid or free** (if Hosting)
   - **Timing** (Upcoming vs Past event)

   This maps to the 18 evergreen Instantly campaigns. The formula outputs the campaign UUID.

5. **Push to Instantly and HeyReach.** Clay pushes the enriched contacts with their assigned campaign into Instantly (email) and HeyReach (LinkedIn) for outreach.

The full flow: **HubSpot list → this script → Clay table → Find People → Email enrichment → Campaign routing → Instantly/HeyReach**

## If something goes wrong

- **Apify errors on specific companies**: Bad LinkedIn URLs in the account list. The script skips them and moves on.
- **Rate limiting**: The script handles retries automatically. If you see persistent rate limits, let Andrew know.
- **Missing fields in Clay**: Check that the webhook URL is correct and the Clay table has a webhook source configured.
- **No events found on a run**: Normal if you've run it recently and no new event posts appeared in the last 14 days.

Questions? Ping Andrew.
