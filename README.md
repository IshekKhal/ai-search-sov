# AI Search Share-of-Voice Monitor & Notion Pipeline

## Find out whether AI search engines are recommending you or your competitors, before your organic traffic tells you

**Your SEO tools tell you where you rank on Google. Nothing tells you whether ChatGPT, Perplexity, Grok, or Google AI Overviews are recommending your product.** This Actor reads your commercial prompts from Notion, queries up to five AI search engines with live web grounding, scores brand mentions and cited domains, and delivers a dated scorecard back to your Notion workspace — with automated Slack alerts when Share of Voice drops.

Tools like Ahrefs and Semrush track traditional blue links. What they cannot do is ask an AI engine "what is the best web scraping platform?", evaluate whether your brand appears, and track your recommendation rank over time without manual spreadsheets. That is what this Actor does.

---

## Why this matters

A buyer asks Perplexity or ChatGPT for the "best workflow automation platform for engineering teams." The model recommends your two main competitors and cites their documentation. Your product is not mentioned at all.

You notice three months later when qualified inbound trials have dropped 25%, and by then every competitor has cemented their authority in the engine's retrieval corpus and citation habits.

Everything you need to catch this early is observable:
- Whether the AI mentions your brand name
- Whether it cites your official domain in its source footnotes
- What position you hold in its recommendation list
- Whether a competitor displaced you from the top spot

This Actor monitors that visibility on a schedule and alerts your team in Slack the moment your Share of Voice dips.

---

## Features

- **Your Notion Database Drives the Search**: Keep your target prompts, brand names, and competitor lists in a Notion table your team already manages. The Actor reads it before every run. Change your search strategy in Notion, not in a form.
- **Multi-Engine Evaluation**: Simultaneously queries **Google AI Overviews**, **Perplexity Sonar**, **OpenAI ChatGPT (GPT-4o)**, **xAI Grok 2**, and **Groq Compound** with live web search grounding.
- **Three Complementary Metrics**:
  - **Share of Voice (SoV%)**: Percentage of queries where your brand is recommended by name.
  - **Citation Domain Share (CDS%)**: Percentage of queries where your official domain is cited as a source link.
  - **Recommendation Position Score (RPS)**: Weighted score factoring rank placement (Rank 1 = 10 pts, Ranks 2–3 = 7 pts, other = 4 pts).
- **Competitor Benchmarking**: Automatically calculates comparative SoV% and displacement deltas against every named competitor.
- **Delivered to Your Notion Pipeline, Not a Dead File**: Each run writes a dated snapshot row directly into your Notion timeline database, building an automated historical trendline you can chart.
- **Smart Slack Drop Alerts**: Dispatches a formatted notification card to Slack *only* when Share of Voice drops beyond your configured threshold (e.g. -5%), preventing channel alert fatigue.
- **Never Sees Your Tokens**: Inbound MCP connectors route through Apify's secure sidecar proxy. Your Notion and Slack credentials are never exposed to Actor code.
- **Drop Funnel Telemetry**: Logs full request dispatch counters (`promptsLoaded`, `queriesDispatched`, `queriesBlocked`, `queriesSucceeded`) so you always know whether low scores stem from visibility shifts or proxy blocks.
- **Dry Run by Default**: Test prompts and inspect scoring scorecards in the run log before writing anything to Notion or Slack.

---

## Usage

### 1. Create two Notion databases

**Monitoring Pack**: tells the Actor what to search for:

| Value | Type |
| :--- | :--- |
| Apify | Brand |
| apify.com | Domain |
| best web scraping platform 2026 | Prompt |
| top data extraction tools for developers | Prompt |
| web scraping API comparison | Prompt |
| Bright Data | Competitor |
| ScraperAPI | Competitor |
| Oxylabs | Competitor |

*Columns: `Value` (Title), `Type` (Select with options `Brand`, `Domain`, `Prompt`, `Competitor`). You need exactly one Brand row and one Domain row. Add as many Prompts and Competitors as you want.*

**SoV Timeline**: where results land after every run:

`Brand` (Title) · `Date` (Date) · `SoV` (Number) · `CDS` (Number) · `RPS` (Number) · `Prompts Tracked` (Number) · `Brand Mentions` (Number) · `Competitor SoV` (Text) · `Top Citation Sources` (Text)

> Use **Number** for metric columns (`SoV`, `CDS`, `RPS`, `Prompts Tracked`, `Brand Mentions`). Number columns chart natively in Notion. Leave this database empty — the Actor populates it automatically.

---

### 2. Connect Notion and Slack MCP connectors

1. In Apify Console → **Settings → MCP connectors → Add connector**.
2. For Notion: enter `https://mcp.notion.com/mcp` → authorize and grant access to both databases.
3. For Slack *(Optional)*: enter `https://mcp.slack.com/mcp` → authorize with your Slack workspace and select `#sov-alerts`.

---

### 3. Configure and run

* **Notion connector**: Select your Notion connector from step 2.
* **Monitoring Pack Database ID**: The 32-character ID from your monitoring pack Notion URL.
* **Timeline Database ID**: The 32-character ID from your timeline Notion URL.
* **Slack connector**: *(Optional)* Select your Slack connector to enable drop alerts.
* **Slack Channel**: Target channel for alert cards (e.g. `#sov-alerts`). Default: `#general`.
* **SoV Drop Threshold (%)**: Minimum percentage drop required to trigger a Slack alert. Default: `5`.
* **Dry Run**: On by default. Scrapes and scores everything in the run log without writing to Notion or Slack.
* **AI Search Engines**: Select which engines to query:
  - `google_ai_overview` — Google AI Overviews via nested search scraper (**No API key needed**).
  - `perplexity` — Perplexity Sonar API (`perplexityApiKey`).
  - `openai_chatgpt` — OpenAI GPT-4o API (`openaiApiKey`).
  - `xai_grok` — xAI Grok 2 API (`xaiApiKey`).
  - `groq_compound` — Groq search-grounded compound API (`groqApiKey`).

---

## What it looks like

![Monitoring pack in Notion](https://raw.githubusercontent.com/IshekKhal/ai-search-sov/main/assets/notion-database-ai-search-monitoring-pack-configuration.png)
*Your monitoring pack in Notion. This is the only place you configure target prompts, brand names, and competitors.*

![SoV timeline in Notion](https://raw.githubusercontent.com/IshekKhal/ai-search-sov/main/assets/notion-database-ai-search-share-of-voice-timeline-history.png)
*Persistent Share-of-Voice timeline in Notion accumulating daily run snapshots with SoV%, CDS%, and RPS metrics.*

![Slack drop alert](https://raw.githubusercontent.com/IshekKhal/ai-search-sov/main/assets/slack-share-of-voice-drop-alert-notification.png)
*Automated Slack alert notification card dispatched to your channel when Share of Voice drops beyond the threshold.*

![Apify Console input](https://raw.githubusercontent.com/IshekKhal/ai-search-sov/main/assets/apify-console-notion-mcp-connector-input-configuration.png)
*One-click Notion and Slack MCP authorization. No API credentials pasted into code.*

![Drop funnel run log](https://raw.githubusercontent.com/IshekKhal/ai-search-sov/main/assets/apify-console-ai-search-drop-funnel-telemetry-runlog.png)
*Terminal drop funnel telemetry and audit summary isolating query health, proxy blocks, and competitor benchmarks.*

---

## Output

Every run writes a snapshot row to Notion **and** returns per-query records in a standardized dataset:

| Field | Description |
| :--- | :--- |
| `prompt` | The commercial search query that was evaluated |
| `engine` | `google_ai_overview`, `perplexity`, `openai_chatgpt`, `xai_grok`, or `groq_compound` |
| `brandMentioned` | Boolean indicating whether your brand name was recommended |
| `domainCited` | Boolean indicating whether your official domain was cited in sources |
| `recommendationRank` | Position in the recommendation list (`1` = first, `null` = not recommended) |
| `citedDomains` | Array of source domains cited in the AI response |
| `winningCitationSources`| Full URLs referenced by the engine for citations |
| `competitorsFound` | Array of named competitors that appeared in the response |
| `displacedByCompetitor` | Name of the competitor occupying the #1 spot when you were displaced |
| `sentiment` | Classification of the mention (`Positive`, `Neutral`, `Negative`, `Omitted`) |
| `featureContext` | Contextual tags associated with your brand (e.g. `fast`, `expensive`, `scalable`) |
| `engineStatus` | Diagnostic status code (e.g. `ok_groq_compound`, `blocked_unusual_traffic`) |
| `responseDurationMs` | Network and generation latency in milliseconds |

### Example dataset item

```json
{
  "timestamp": "2026-08-15T01:00:00.000Z",
  "engine": "groq_compound",
  "prompt": "best enterprise web scraping platform",
  "targetBrand": "Apify",
  "targetDomain": "apify.com",
  "brandMentioned": true,
  "domainCited": true,
  "recommendationRank": 1,
  "citedDomains": ["apify.com", "brightdata.com", "scraperapi.com"],
  "winningCitationSources": [
    "https://apify.com/web-scraping",
    "https://brightdata.com/products"
  ],
  "competitorsFound": ["Bright Data", "ScraperAPI"],
  "displacedByCompetitor": null,
  "sentiment": "Positive",
  "featureContext": ["cloud platform", "actor ecosystem", "reliable"],
  "engineStatus": "ok_groq_compound",
  "responseDurationMs": 1820
}
```

---

## Supported AI search engines

| Engine | Grounding Method | Features |
| :--- | :--- | :--- |
| **Google AI Overview** | Google SERP Scraping | No API key needed. Residential proxies recommended. |
| **Perplexity AI** | Sonar Pro API (`sonar`) | Fast, native search grounding and citation URLs. |
| **OpenAI ChatGPT** | GPT-4o API | Direct parametric and grounded reasoning evaluation. |
| **xAI Grok** | Grok 2 API (`grok-2-mini`) | Fast, real-time web knowledge evaluation. |
| **Groq Compound** | Groq Live Web Search | Search-grounded agentic workflow with citation domains. |

---

## What it does not do

- It does not generate artificial reviews or manipulate LLM training data. It measures your authentic brand presence so you can steer your content and SEO strategy.
- It cannot predict future non-deterministic responses with 100% certainty. AI models provide stochastic answers — schedule the Actor daily and monitor the 7-day trendline.

---

## Integrations

Beyond Notion and Slack, output datasets can be pulled via the [Apify API](https://docs.apify.com/api/v2) or routed into Google Sheets, Airtable, Make, or Zapier webhooks.

---

Built by [Abhishek Khanra](https://apify.com/ishekofficial). Pay-per-use, no subscription required.
