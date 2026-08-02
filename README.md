# WDW Public Permit Feed

Live curated feed of publicly available Walt Disney World construction permits, Notices of Commencement (NOCs), and related filings (CFTOD, Orange County, SFWMD, Osceola).

**Live page:** Once GitHub Pages is enabled → `https://scoopdisney.github.io/wdw-permit-watch/`

**JSON feed:** `https://scoopdisney.github.io/wdw-permit-watch/data/permits.json`

## Why this exists

Disney World permits are public records, but there is no official public RSS/API. This repository maintains a clean, newest-first feed that can be updated manually or via automation, following the same pattern as the existing [disney-menu-watch](https://github.com/scoopdisney/disney-menu-watch) project.

## Official sources (always check these)

| Source | URL | What it covers |
|--------|-----|----------------|
| CFTOD Accela | https://permitting.oversightdistrict.org | Building permits for most of WDW |
| Orange County Official Records | https://www.occompt.com/368/Search-Official-Records | Notices of Commencement |
| SFWMD | https://www.sfwmd.gov/doing-business-with-us/permits | Environmental / stormwater |
| Osceola County | https://permits.osceola.org/ | Portion of property in Osceola |

## Current status of automation

- ✅ Live static page + JSON that updates when new data is committed
- ✅ GitHub Action that regenerates the page from `data/permits.json`
- ⚠️ Full automated scraping of Accela / Comptroller is **not** enabled by default (no public API, dynamic pages, anti-bot protections). New entries are currently curated and pushed.
- Future: optional Playwright-based scanner or monitoring of reliable secondary sources can be added in `scripts/`.

## How to add a new permit

1. Edit `data/permits.json` — add a new object at the **top** of the `permits` array.
2. Commit & push. The Action will regenerate `index.html` if needed (or the client-side JS will pick it up).

Example entry:

```json
{
  "id": "unique-slug-YYYY-MM-DD",
  "date": "2026-08-05",
  "title": "Short descriptive title",
  "description": "What the filing says / what it appears to cover.",
  "location": "Park or resort + more specific if known",
  "tags": ["Magic Kingdom", "Notice of Commencement"],
  "type": "NOC",
  "contractor": "Optional",
  "source": "https://...",
  "source_name": "WDWNT"
}
```

## Local development

```bash
# Just open index.html or serve the folder
npx serve .
```

## License

Public domain / CC0 for the feed data. Use freely for The Disney Scoop or personal tracking.
