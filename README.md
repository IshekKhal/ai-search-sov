# AI Search Share-of-Voice Monitor

## Find out whether AI is recommending you or your competitors, before your traffic tells you

**Your SEO tool tells you where you rank on Google. Nothing tells you whether ChatGPT, Perplexity, or Google AI Overviews are recommending your product.** This queries AI search engines with the commercial prompts your customers actually type, checks whether you get mentioned, and writes a dated scorecard back to your Notion workspace.

Tools like Ahrefs and Semrush track traditional search rankings. What they cannot do is ask an AI engine "what is the best web scraping platform?", read the answer, check whether your brand appears, and track that over time in your own workspace without manual spreadsheets. That is what this does.

---

## Why this matters

A buyer types "best enterprise web scraping platform" into Perplexity. It recommends Bright Data and ScraperAPI. Your product is not mentioned. Nobody tells you.

You notice three months later when qualified inbound leads have declined 20%, and by then every competitor has cemented their position in the model's training data and citation habits.

Everything you need to catch this early is observable. Whether the AI mentions your brand. Whether it cites your domain. What rank position you appear at. Whether a competitor displaced you. This monitors it on a schedule and alerts you on Slack the moment your Share-of-Voice drops.

---

## Features

- **Reads your monitoring config from Notion**, so you never re-enter prompts, brand names, or competitor lists in a form
- **Writes a dated timeline row back to Notion** after every run, building a persistent SoV trendline you can chart
- **Dispatches Slack alerts** when Share-of-Voice drops below a configurable threshold
- **Tracks three metrics per run**: Share-of-Voice (SoV%), Citation Domain Share (CDS%), Recommendation Position Score (RPS)
- **Benchmarks you against every named competitor**, so you know who displaced you and by how much
- **Detects sentiment and context tags** — are you mentioned as "best", "leader", or "expensive", "complex"?
- **Dry run by default**, so you can read the full report before anything is written anywhere
- **Never sees your Notion or Slack tokens.** Apify holds them and this Actor is only permitted the tools it declared
- **Drop funnel logging** from hour one — if a query was blocked or a result was empty, you know exactly why

---

## Usage

### 1. Create two Notion databases

**Monitoring Pack**: tells the Actor what to search for:

| Value | Type |
| :--- | :--- |
| Apify | Brand |
| apify.com | Domain |
| best enterprise web scraping platform | Prompt |
| top data extraction tools for developers | Prompt |
| best alternative to Bright Data | Prompt |
| best web scraping API 2026 | Prompt |
| Bright Data | Competitor |
| ScraperAPI | Competitor |
| Octoparse | Competitor |

Columns: `Value` (Title), `Type` (Select).

Create the Select options by hand: click the Type cell, type `Prompt`, press Enter. Repeat for `Brand`, `Domain`, `Competitor`. You need exactly one Brand row and one Domain row. Add as many Prompts and Competitors as you want.

**SoV Timeline**: where results land after every run:

`Brand` (Title) · `Date` (Date) · `SoV` (Number) · `CDS` (Number) · `RPS` (Number) · `Prompts Tracked` (Number) · `Brand Mentions` (Number) · `Competitor SoV` (Text) · `Top Citation Sources` (Text)

> Use **Number** for all metric columns, not Text. Number columns chart properly in Notion. Leave this database empty — the Actor fills it.

### 2. Connect Notion

In Apify Console → **Settings → MCP connectors → Add connector** → enter `https://mcp.notion.com/mcp` → authorize and grant access to both databases. That's the only setup step.

### 3. (Optional) Connect Slack for drop alerts

In Apify Console → **Settings → MCP connectors → Add connector** → enter `https://mcp.slack.com/mcp` → authorize with your Slack workspace. You do NOT need a Slack app or bot. Skip this step if you don't want alerts — the Actor works fine without Slack.

### 4. Configure and run

*   **Notion connector**: Select the connector you created in step 2.
*   **Database IDs**: The 32-character ID from each Notion URL (the hex string before `?v=`).
*   **Slack connector**: *(Optional)* Select if you set one up in step 3.
*   **Dry run**: Scrape and score everything, log what *would* be written, without touching Notion. On by default. Recommended for your first run.
*   **SoV drop threshold**: Alert on Slack when SoV drops by this many percentage points. Default `5`.
*   **Engines**: Select which AI search engines to monitor:
    *   `google_ai_overview` — Google AI Overviews via nested Google Search Scraper (**No API key needed**).
    *   `perplexity` — Perplexity AI via official API (`perplexityApiKey` with Sonar Pro model) or nested scraper fallback.
    *   `openai_chatgpt` — ChatGPT via OpenAI API (`openaiApiKey` with GPT-4o model).
    *   `openai_groq_oss` — OpenAI GPT-OSS 120B on Groq LPUs (`groqApiKey`).
    *   `groq_compound` — Groq Compound Search via Groq API (`groqApiKey` with Groq search-grounded model).
    *   `xai_grok` — xAI Grok via xAI API (`xaiApiKey` with Grok 2 model).
*   **Proxy**: Residential proxy recommended for Google AI Overviews. Without one, search engines block automated queries.

---

## Output

One row per prompt × engine combination, in the dataset.

| Field | What it is |
| :--- | :--- |
| `prompt` | The commercial search query that was evaluated |
| `engine` | `google_ai_overview`, `perplexity`, `openai_chatgpt`, `openai_groq_oss`, `groq_compound`, or `xai_grok` |
| `brandMentioned` | Whether the AI answer mentioned your brand by name |
| `domainCited` | Whether the AI answer cited your domain in its sources |
| `recommendationRank` | Your position in the AI's recommendation list (1 = first, null = not listed) |
| `citedDomains` | All source domains the AI cited in its answer |
| `competitorsFound` | Which of your named competitors appeared in the answer |
| `displacedByCompetitor` | If a competitor holds the #1 position instead of you, which one |
| `sentiment` | `Positive`, `Neutral`, `Negative`, or `Omitted` (not mentioned at all) |
| `featureContext` | Context tags: what attributes the AI associated with your brand |
| `engineStatus` | `ok_google_serp`, `ok_perplexity_api`, `ok_perplexity`, `ok_openai_chatgpt`, `ok_openai_groq_oss`, `ok_groq_compound`, `ok_xai_grok`, `blocked_unusual_traffic`, or `network_error` |

### Example row

```json
{
  "timestamp": "2026-08-11T09:00:00.000Z",
  "engine": "google_ai_overview",
  "prompt": "best enterprise web scraping platform",
  "targetBrand": "Apify",
  "targetDomain": "apify.com",
  "brandMentioned": true,
  "domainCited": true,
  "recommendationRank": 2,
  "citedDomains": ["brightdata.com", "apify.com", "scraperapi.com"],
  "winningCitationSources": ["https://brightdata.com/products", "https://apify.com/web-scraping"],
  "competitorsFound": ["Bright Data", "ScraperAPI"],
  "displacedByCompetitor": "Bright Data",
  "sentiment": "Positive",
  "featureContext": ["robust", "reliable"],
  "engineStatus": "ok_google_serp",
  "responseDurationMs": 2340
}
```

### Aggregate metrics (in RUN_SUMMARY)

| Metric | What it means |
| :--- | :--- |
| **SoV%** | Percentage of prompts where the AI mentioned your brand |
| **CDS%** | Percentage of prompts where the AI cited your domain in sources |
| **RPS** | Recommendation Position Score: 10 for rank 1, 7 for rank 2–3, 4 for lower |
| **deltaSoV** | Change from the previous run's SoV%. Negative = you are losing visibility |

---

## Supported AI engines

| Engine | Execution Method | Model / Underlying Mechanism |
| :--- | :--- | :--- |
| **Google AI Overview** | `Actor.call('apify/google-search-scraper')` | Google SERP with AI Overview extraction |
| **Perplexity AI** | Direct API (`perplexityApiKey`) / Scraper Fallback | `sonar` (Lightweight, 85% cheaper) |
| **OpenAI ChatGPT** | Direct API (`openaiApiKey`) | `gpt-4o-mini` (Lightweight, 94% cheaper) |
| **xAI Grok** | Direct API (`xaiApiKey`) | `grok-2-mini` (Lightweight, 85% cheaper) |
| **Groq Compound** | Direct API (`groqApiKey`) | `groq/compound` (Agentic Web Search, up to 10 tool calls) |
| **OpenAI GPT-OSS on Groq** | Direct API (`groqApiKey`) | `openai/gpt-oss-120b` (120B Open-Weights Model on LPUs) |

---

## Cost

Each run makes one HTTP request per prompt × engine. A monitoring pack with 10 prompts across 2 engines = 20 requests.

- **Compute**: ~128 MB RAM, 30 seconds per query. A 10-prompt run takes ~5 minutes. Well within Apify free tier.
- **Proxy**: Residential proxy recommended for Google. ~0.01–0.03 USD per 20 requests depending on provider and plan.
- **MCP connectors**: Reading and writing to Notion through the Apify MCP proxy is included in the platform — no additional cost.

### Testing cost

Your first dry run costs nothing beyond proxy bandwidth. The Notion connector read is a single API call. No writes happen during dry run.

---

## What it does not do

It does not optimize your content for AI engines. It measures your current visibility so you can decide what to optimize. For the optimization side, talk to your content team about structured data, citation-worthy content, and entity recognition.

It cannot tell you what the AI model "thinks" — only what it outputs for a specific prompt in a specific locale at a specific time. AI answers are non-deterministic. Run daily and look at the trend, not any single data point.
