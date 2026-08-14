import { gotScraping } from 'got-scraping';
import { Actor, log } from 'apify';
import {
    parseBrandMention,
    extractCitationDomains,
    isDomainCited,
    parseRankPosition,
    parseCompetitors,
    classifySentimentAndContext
} from '../parser.js';

export async function closeEngines() {
    // All engine scrapers use nested platform actors or HTTP APIs; no persistent browser resources to close.
}

/**
 * Scraping Engine Module for AI Search Share-of-Voice Monitor
 *
 * Supported engines:
 *  1. google_ai_overview → Nested Actor.call to apify/google-search-scraper (No API key needed)
 *  2. perplexity         → Official Perplexity API (Sonar Pro) if API key provided, else nested actor zhorex/perplexity-ai-scraper
 *  3. openai_chatgpt     → Direct OpenAI API (GPT-4o) via gotScraping HTTP
 *  4. xai_grok           → Direct xAI API (Grok 2) via gotScraping HTTP
 *  5. groq_compound      → Direct Groq API (Groq Compound search-grounded) via gotScraping HTTP
 */
function extractRetryDelay(errMsg, retryAfterHeader, attempt) {
    if (retryAfterHeader) {
        const headerVal = parseFloat(retryAfterHeader);
        if (!isNaN(headerVal) && headerVal > 0) return Math.ceil(headerVal) + 2;
    }
    if (errMsg) {
        // Parse "try again in 3m35.136s" (minutes + seconds)
        const minsMatch = errMsg.match(/try again in (\d+)m([\d.]+)s/i);
        if (minsMatch) {
            const totalSec = parseInt(minsMatch[1], 10) * 60 + parseFloat(minsMatch[2]);
            if (totalSec > 0) return Math.ceil(totalSec) + 2;
        }
        // Parse "try again in 6.45s" (seconds only)
        const secsMatch = errMsg.match(/try again in ([\d.]+)\s*s/i);
        if (secsMatch && secsMatch[1]) {
            const parsed = parseFloat(secsMatch[1]);
            if (!isNaN(parsed) && parsed > 0) return Math.ceil(parsed) + 2;
        }
    }
    // Default sliding window backoff: Attempt 1 = 30s, Attempt 2 = 45s
    return attempt === 1 ? 30 : 45;
}

async function callGroqApiWithRetry({ searchUrl, groqApiKey, payload, prompt, maxRetries = 3 }) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const response = await gotScraping({
            url: searchUrl,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey.trim()}`,
                'Content-Type': 'application/json'
            },
            json: payload,
            timeout: { request: 35000 },
            throwHttpErrors: false
        });

        let data = null;
        try {
            data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
        } catch {
            data = response.body;
        }

        if (data?.error || response.statusCode >= 400) {
            const errMsg = data?.error?.message || `HTTP ${response.statusCode}`;
            const isRateLimit = response.statusCode === 429 || data?.error?.code === 'rate_limit_exceeded' || errMsg.toLowerCase().includes('rate limit');
            const isEntityTooLarge = response.statusCode === 413 || data?.error?.code === 'request_too_large' || errMsg.toLowerCase().includes('entity too large');

            // Detect DAILY token exhaustion (TPD) — skip immediately, don't burn Apify credits waiting
            const isDailyExhaustion = errMsg.toLowerCase().includes('tokens per day') || errMsg.toLowerCase().includes('per day');
            if (isRateLimit && isDailyExhaustion) {
                log.warning(`Groq DAILY token limit exhausted for "${prompt}". Skipping — no point waiting minutes/hours.`);
                throw new Error(`Groq daily token limit exhausted: ${errMsg}`);
            }

            if (isRateLimit && attempt <= maxRetries) {
                const waitSeconds = extractRetryDelay(errMsg, response.headers?.['retry-after'], attempt);
                // If wait exceeds 60s, it's likely a daily/hourly limit — skip instead of burning compute
                if (waitSeconds > 60) {
                    log.warning(`Groq rate limit for "${prompt}" requires ${waitSeconds}s wait (likely daily/hourly cap). Skipping to save Apify credits.`);
                    throw new Error(`Groq rate limit requires ${waitSeconds}s wait — skipping: ${errMsg}`);
                }
                log.warning(`Groq API rate limit hit for "${prompt}" (attempt ${attempt}/${maxRetries + 1}). Pausing ${waitSeconds}s...`);
                await new Promise((r) => setTimeout(r, waitSeconds * 1000));
                continue;
            }

            if (isEntityTooLarge && attempt <= maxRetries) {
                log.warning(`Groq 413 Entity Too Large for live search on "${prompt}". Retrying with tools disabled on ${payload.model}...`);
                payload.compound_custom = {
                    tools: {
                        enabled_tools: []
                    }
                };
                payload.messages = [
                    {
                        role: 'user',
                        content: `Provide objective recommendations naming top platforms, services, and brands with official domain website URLs for: ${prompt}`
                    }
                ];
                continue;
            }

            throw new Error(`Groq API Error (${response.statusCode}): ${errMsg}`);
        }

        // Spacing delay to prevent token burst on Groq on-demand tier (8,000 TPM limit)
        await new Promise((r) => setTimeout(r, 3000));
        return data;
    }
}

export async function evaluateQuery({
    prompt,
    engine = 'google_ai_overview',
    brandName,
    domain,
    competitors = [],
    country = 'US',
    language = 'en',
    proxyUrl,
    openaiApiKey,
    perplexityApiKey,
    xaiApiKey,
    groqApiKey
}) {
    const startTime = Date.now();
    let rawResponseExcerpt = '';
    let engineStatus = 'ok';
    let searchUrl = '';
    let hasAiOverview = null; // only populated for google_ai_overview engine
    let fullResponseText = '';

    // ==========================================
    // 1. OpenAI ChatGPT (Direct API)
    // ==========================================
    if (engine === 'openai_chatgpt') {
        searchUrl = 'https://api.openai.com/v1/chat/completions';
        log.info(`Querying OpenAI ChatGPT (GPT-4o-mini) for: "${prompt}"`);

        if (!openaiApiKey || !openaiApiKey.trim()) {
            log.warning(`OpenAI API key missing. Skipping ChatGPT query for prompt: "${prompt}". Provide 'openaiApiKey' in Actor input.`);
            engineStatus = 'missing_openai_key';
            rawResponseExcerpt = 'OpenAI API key missing in input configuration.';
        } else {
            try {
                const response = await gotScraping({
                    url: searchUrl,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${openaiApiKey.trim()}`,
                        'Content-Type': 'application/json'
                    },
                    json: {
                        model: 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: 'Search the web and provide comprehensive, objective recommendations for the user query, explicitly naming top platforms, tools, services, and brands. Include official domain website URLs (e.g. domain.com) for recommended platforms.'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ],
                        temperature: 0.2
                    },
                    timeout: { request: 30000 }
                });

                const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
                fullResponseText = data?.choices?.[0]?.message?.content || '';
                rawResponseExcerpt = fullResponseText;
                engineStatus = 'ok_openai_chatgpt';
            } catch (err) {
                log.warning(`OpenAI API error for "${prompt}": ${err.message}`);
                engineStatus = 'openai_api_error';
                rawResponseExcerpt = `OpenAI API Error: ${err.message}`;
            }
        }

    // ==========================================
    // 2. xAI Grok (Direct API)
    // ==========================================
    } else if (engine === 'xai_grok') {
        searchUrl = 'https://api.x.ai/v1/chat/completions';
        log.info(`Querying xAI Grok (Grok 2 Mini) for: "${prompt}"`);

        if (!xaiApiKey || !xaiApiKey.trim()) {
            log.warning(`xAI API key missing. Skipping Grok query for prompt: "${prompt}". Provide 'xaiApiKey' in Actor input.`);
            engineStatus = 'missing_xai_key';
            rawResponseExcerpt = 'xAI API key missing in input configuration.';
        } else {
            try {
                const response = await gotScraping({
                    url: searchUrl,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${xaiApiKey.trim()}`,
                        'Content-Type': 'application/json'
                    },
                    json: {
                        model: 'grok-2-mini',
                        messages: [
                            {
                                role: 'system',
                                content: 'Search the web and provide comprehensive, objective recommendations for the user query, explicitly naming top platforms, tools, services, and brands. Include official domain website URLs (e.g. domain.com) for recommended platforms.'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ],
                        temperature: 0.2
                    },
                    timeout: { request: 30000 }
                });

                const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
                fullResponseText = data?.choices?.[0]?.message?.content || '';
                rawResponseExcerpt = fullResponseText;
                engineStatus = 'ok_xai_grok';
            } catch (err) {
                log.warning(`xAI API error for "${prompt}": ${err.message}`);
                engineStatus = 'xai_api_error';
                rawResponseExcerpt = `xAI API Error: ${err.message}`;
            }
        }

    // ==========================================
    // 3. Groq Compound (Direct API with Web Search)
    // ==========================================
    } else if (engine === 'groq_compound') {
        searchUrl = 'https://api.groq.com/openai/v1/chat/completions';
        log.info(`Querying Groq Compound (Web Search) for: "${prompt}"`);

        if (!groqApiKey || !groqApiKey.trim()) {
            log.warning(`Groq API key missing. Skipping Groq query for prompt: "${prompt}". Provide 'groqApiKey' in Actor input.`);
            engineStatus = 'missing_groq_key';
            rawResponseExcerpt = 'Groq API key missing in input configuration.';
        } else {
            try {
                const data = await callGroqApiWithRetry({
                    searchUrl,
                    groqApiKey,
                    prompt,
                    payload: {
                        model: 'groq/compound-mini',
                        messages: [
                            {
                                role: 'user',
                                content: `${prompt}. Name top platforms, services, and brands with official domain website URLs (e.g. domain.com).`
                            }
                        ],
                        compound_custom: {
                            tools: {
                                enabled_tools: ['web_search']
                            }
                        }
                    }
                });

                const msg = data?.choices?.[0]?.message;
                const executedToolsText = Array.isArray(msg?.executed_tools)
                    ? msg.executed_tools.map((t) => (typeof t === 'string' ? t : JSON.stringify(t))).join('\n')
                    : (msg?.executed_tools ? JSON.stringify(msg.executed_tools) : '');

                fullResponseText = [msg?.content, msg?.reasoning, executedToolsText].filter(Boolean).join('\n\n');
                if (!fullResponseText.trim()) {
                    fullResponseText = typeof data === 'string' ? data : JSON.stringify(data);
                }
                rawResponseExcerpt = fullResponseText;
                engineStatus = 'ok_groq_compound';
            } catch (err) {
                log.warning(`Groq API error for "${prompt}": ${err.message}`);
                engineStatus = 'groq_api_error';
                rawResponseExcerpt = `Groq API Error: ${err.message}`;
            }
        }

    // ==========================================
    // 4. OpenAI GPT-OSS on Groq (Direct API)
    // ==========================================
    } else if (engine === 'openai_groq_oss') {
        searchUrl = 'https://api.groq.com/openai/v1/chat/completions';
        log.info(`Querying OpenAI GPT-OSS (120B) on Groq for: "${prompt}"`);

        if (!groqApiKey || !groqApiKey.trim()) {
            log.warning(`Groq API key missing. Skipping OpenAI GPT-OSS query for prompt: "${prompt}". Provide 'groqApiKey' in Actor input.`);
            engineStatus = 'missing_groq_key';
            rawResponseExcerpt = 'Groq API key missing in input configuration.';
        } else {
            try {
                const data = await callGroqApiWithRetry({
                    searchUrl,
                    groqApiKey,
                    prompt,
                    payload: {
                        model: 'openai/gpt-oss-120b',
                        messages: [
                            {
                                role: 'system',
                                content: 'Provide comprehensive, objective recommendations for the query, explicitly naming top platforms, tools, services, and brands. Include official domain website URLs (e.g. domain.com) for recommended platforms.'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ]
                    }
                });

                const msg = data?.choices?.[0]?.message;
                fullResponseText = msg?.content || msg?.reasoning || (msg?.tool_calls ? JSON.stringify(msg.tool_calls) : '') || '';
                rawResponseExcerpt = fullResponseText;
                engineStatus = 'ok_openai_groq_oss';
            } catch (err) {
                log.warning(`Groq OpenAI GPT-OSS API error for "${prompt}": ${err.message}`);
                engineStatus = 'groq_api_error';
                rawResponseExcerpt = `Groq OpenAI GPT-OSS Error: ${err.message}`;
            }
        }

    // ==========================================
    // 4. Perplexity AI (API or Scraper Fallback)
    // ==========================================
    } else if (engine === 'perplexity') {
        if (perplexityApiKey && perplexityApiKey.trim()) {
            // Official Perplexity API (Sonar)
            searchUrl = 'https://api.perplexity.ai/chat/completions';
            log.info(`Querying Perplexity API (Sonar) for: "${prompt}"`);

            try {
                const response = await gotScraping({
                    url: searchUrl,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${perplexityApiKey.trim()}`,
                        'Content-Type': 'application/json'
                    },
                    json: {
                        model: 'sonar',
                        messages: [
                            {
                                role: 'system',
                                content: 'Search the web and provide comprehensive, objective recommendations for the user query, explicitly naming top platforms, tools, services, and brands.'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ]
                    },
                    timeout: { request: 35000 }
                });

                const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
                const answerText = data?.choices?.[0]?.message?.content || '';
                const citations = data?.citations || [];
                const citationList = Array.isArray(citations)
                    ? citations.map(c => typeof c === 'string' ? c : (c.url || c)).join('\n')
                    : '';

                fullResponseText = [answerText, citationList ? `Citations:\n${citationList}` : ''].filter(Boolean).join('\n\n');
                rawResponseExcerpt = fullResponseText.substring(0, 3000);
                engineStatus = 'ok_perplexity_api';
                log.info(`Perplexity API extracted ${fullResponseText.length} chars. Contains "${brandName}": ${fullResponseText.toLowerCase().includes(brandName.toLowerCase())}`);
            } catch (apiErr) {
                log.warning(`Perplexity API error for "${prompt}": ${apiErr.message}`);
                engineStatus = 'perplexity_api_error';
                rawResponseExcerpt = `Perplexity API Error: ${apiErr.message}`;
            }
        } else {
            // Fallback: Nested Actor call to zhorex/perplexity-ai-scraper
            searchUrl = `https://www.perplexity.ai/search?q=${encodeURIComponent(prompt)}`;
            log.info(`Querying Perplexity via nested zhorex/perplexity-ai-scraper (No API key) for: "${prompt}"`);

            try {
                const scraperInput = {
                    queries: [prompt],
                };

                const scraperRun = await Actor.call('zhorex/perplexity-ai-scraper', scraperInput, {
                    memory: 2048,
                    waitSecs: 120,
                });

                log.info(`Perplexity Scraper run finished. Status: ${scraperRun.status}, datasetId: ${scraperRun.defaultDatasetId}`);

                if (scraperRun.status !== 'SUCCEEDED') {
                    log.warning(`Perplexity Scraper run finished with status: ${scraperRun.status}. Perplexity actively blocks Apify proxy IPs at Cloudflare edge. Please provide 'perplexityApiKey' in your Actor input to use the official Perplexity API (sonar-pro) for guaranteed 100% uptime.`);
                    engineStatus = 'network_error';
                    rawResponseExcerpt = `Perplexity Scraper finished with status: ${scraperRun.status}. Provide 'perplexityApiKey' in input.`;
                } else {
                    const dataset = await Actor.openDataset(scraperRun.defaultDatasetId, { forceCloud: true });
                    const { items } = await dataset.getData({ limit: 1 });

                    if (!items || items.length === 0) {
                        log.warning(`Perplexity Scraper returned 0 items for: "${prompt}". Perplexity actively blocks Apify proxy IPs at Cloudflare edge. Please provide 'perplexityApiKey' in your Actor input to use the official Perplexity API (sonar-pro) for guaranteed 100% uptime.`);
                        engineStatus = 'network_error';
                        rawResponseExcerpt = 'Perplexity Scraper returned empty dataset (IP blocked by Cloudflare). Provide perplexityApiKey for direct API access.';
                    } else {
                        const result = items[0];
                        const answerText = result.answer || result.text || result.response || result.output || (typeof result === 'string' ? result : JSON.stringify(result));
                        const sources = result.sources || result.citedSources || result.searchResults || [];
                        const sourceText = Array.isArray(sources)
                            ? sources.map(s => typeof s === 'string' ? s : `${s.title || ''} (${s.url || s.link || s.domain || ''})`).filter(Boolean).join('\n')
                            : '';

                        fullResponseText = [answerText, sourceText].filter(Boolean).join('\n\n');
                        rawResponseExcerpt = fullResponseText.substring(0, 3000);
                        log.info(`Perplexity total extracted: ${fullResponseText.length} chars. Contains "${brandName}": ${fullResponseText.toLowerCase().includes(brandName.toLowerCase())}`);
                        engineStatus = 'ok_perplexity';
                    }
                }
            } catch (perplexityErr) {
                log.warning(`Perplexity nested actor call failed for "${prompt}": ${perplexityErr.message}`);
                engineStatus = 'network_error';
                rawResponseExcerpt = `Perplexity nested actor error: ${perplexityErr.message}`;
            }
        }

    // ==========================================
    // 5. Google AI Overview (Apify Scraper)
    // ==========================================
    } else if (engine === 'google_ai_overview') {
        const cleanCountry = (country || '').trim().toUpperCase();
        const validCountry = (cleanCountry && cleanCountry !== 'GLOBAL' && !cleanCountry.includes('GLOBAL') && cleanCountry.length === 2)
            ? cleanCountry : undefined;
        const langCode = (language || '').trim().toLowerCase() || undefined;

        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(prompt)}`;
        log.info(`Querying Google via nested apify/google-search-scraper for: "${prompt}"`);

        try {
            const scraperInput = {
                queries: prompt,
                maxPagesPerQuery: 1,
                resultsPerPage: 10,
                mobileResults: false,
                ...(validCountry ? { countryCode: validCountry } : {}),
                ...(langCode ? { languageCode: langCode } : {}),
            };

            const scraperRun = await Actor.call('apify/google-search-scraper', scraperInput, {
                memory: 2048,
                waitSecs: 120,
            });

            log.info(`Google Search Scraper run finished. Status: ${scraperRun.status}, datasetId: ${scraperRun.defaultDatasetId}`);

            if (scraperRun.status !== 'SUCCEEDED') {
                log.warning(`Google Search Scraper run did not succeed: ${scraperRun.status}`);
                engineStatus = 'network_error';
                rawResponseExcerpt = `Google Search Scraper finished with status: ${scraperRun.status}`;
            } else {
                const dataset = await Actor.openDataset(scraperRun.defaultDatasetId, { forceCloud: true });
                const { items } = await dataset.getData({ limit: 1 });

                if (!items || items.length === 0) {
                    log.warning(`Google Search Scraper returned 0 items for: "${prompt}"`);
                    engineStatus = 'network_error';
                    rawResponseExcerpt = 'Google Search Scraper returned empty dataset.';
                } else {
                    const result = items[0];
                    const textParts = [];

                    if (result.aiOverviewText || result.aiOverview) {
                        hasAiOverview = true;
                        const aioText = result.aiOverviewText || (typeof result.aiOverview === 'string' ? result.aiOverview : JSON.stringify(result.aiOverview));
                        textParts.push(`AI Overview: ${aioText}`);
                        log.info(`Google AI Overview found: ${aioText.length} chars`);
                    } else {
                        hasAiOverview = false;
                        log.info(`No AI Overview present for: "${prompt}"`);
                    }

                    const organicResults = result.organicResults || result.searchResults || [];
                    if (organicResults.length > 0) {
                        log.info(`Google organic results: ${organicResults.length} items`);
                        for (const r of organicResults.slice(0, 10)) {
                            const title = r.title || '';
                            const snippet = r.description || r.snippet || '';
                            const url = r.url || r.link || '';
                            textParts.push(`${title} - ${snippet} (${url})`);
                        }
                    }

                    const paa = result.peopleAlsoAsk || result.relatedQuestions || [];
                    if (paa.length > 0) {
                        for (const q of paa.slice(0, 5)) {
                            textParts.push(`PAA: ${q.question || q} — ${q.answer || ''}`);
                        }
                    }

                    fullResponseText = textParts.join('\n');
                    rawResponseExcerpt = fullResponseText.substring(0, 3000);
                    log.info(`Google total extracted: ${fullResponseText.length} chars. Contains "${brandName}": ${fullResponseText.toLowerCase().includes(brandName.toLowerCase())}`);
                    engineStatus = 'ok_google_serp';
                }
            }
        } catch (googleErr) {
            log.warning(`Google nested actor call failed for "${prompt}": ${googleErr.message}`);
            engineStatus = 'network_error';
            rawResponseExcerpt = `Google nested actor error: ${googleErr.message}`;
        }
    }

    const durationMs = Date.now() - startTime;

    // Check for error statuses
    if (engineStatus.includes('error') || engineStatus.includes('missing') || engineStatus === 'blocked_unusual_traffic' || engineStatus === 'network_error') {
        return {
            timestamp: new Date().toISOString(),
            engine,
            prompt,
            targetBrand: brandName,
            targetDomain: domain,
            brandMentioned: false,
            domainCited: false,
            recommendationRank: null,
            citedDomains: [],
            winningCitationSources: [],
            competitorsFound: [],
            displacedByCompetitor: null,
            sentiment: 'Omitted',
            featureContext: [],
            rawResponseExcerpt,
            engineStatus,
            responseDurationMs: durationMs,
            searchUrl,
            hasAiOverview
        };
    }

    // Standard Response Extraction & Parsing over FULL response text
    const textToParse = fullResponseText || rawResponseExcerpt;
    const brandMentioned = parseBrandMention(textToParse, brandName);
    const { urls: citationUrls, domains: citedDomains } = extractCitationDomains(textToParse);
    const domainCited = isDomainCited(citedDomains, textToParse, domain);
    const recommendationRank = parseRankPosition(textToParse, brandName);
    const { competitorsFound, displacedByCompetitor } = parseCompetitors(textToParse, competitors, brandName, recommendationRank);
    const { sentiment, featureContext } = classifySentimentAndContext(textToParse, brandName);

    return {
        timestamp: new Date().toISOString(),
        engine,
        prompt,
        targetBrand: brandName,
        targetDomain: domain,
        brandMentioned,
        domainCited,
        recommendationRank,
        citedDomains,
        winningCitationSources: citationUrls.slice(0, 5),
        competitorsFound,
        displacedByCompetitor,
        sentiment,
        featureContext,
        rawResponseExcerpt: textToParse.substring(0, 1500),
        engineStatus,
        responseDurationMs: durationMs,
        searchUrl,
        hasAiOverview
    };
}
