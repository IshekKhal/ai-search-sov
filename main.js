/**
 * AI Search Share-of-Voice Monitor — Notion-driven.
 *
 * Architecture: Notion → scrape → score → Notion + Slack.
 *
 * The connector fires FIRST. The user's own Notion database decides what gets
 * scraped (prompts, brand, competitors) and the same workspace receives the
 * time-series results. A scheduled daily run builds a persistent SoV trendline
 * without the user touching a spreadsheet.
 *
 * Run phases:
 *   0. Connect to MCP connectors through the Apify MCP proxy
 *   1. READ  — monitoring pack from Notion  (prompts, brand, domain, competitors)
 *   2. READ  — existing timeline entries    (for trend comparison)
 *   3. SCRAPE — Google AI Overviews + Perplexity  (via got-scraping + proxy)
 *   4. PARSE  — brand mentions, citations, rank, competitors, sentiment
 *   5. SCORE  — SoV%, CDS%, RPS, competitor benchmarks, delta from previous
 *   6. WRITE  — timeline row back to Notion (unless dry run)
 *   7. ALERT  — Slack card if SoV dropped (unless dry run or no Slack connector)
 *
 * Reminder that cost Actor A a day: MCP connectors DO NOT WORK under local
 * `apify run`. APIFY_MCP_PROXY_URL is only injected on Apify-hosted runs.
 * Deploy, then run in Console.
 */

import { Actor, log } from 'apify';

import { connectToConnector, closeAll } from './src/connectors/mcpClient.js';
import { printToolReport } from './src/connectors/discovery.js';
import {
    resolveNotionTools,
    readMonitoringPack,
    readTimelineHistory,
    writeTimelineEntry,
} from './src/connectors/notion.js';
import {
    resolveSlackTools,
    dispatchSovDropAlert,
} from './src/connectors/slack.js';
import { evaluateQuery, closeEngines } from './src/engines/index.js';
import { calculateMetrics } from './src/metrics.js';
import { processHistoricalState } from './src/state.js';
import { cleanRecord } from './src/helpers/cleaners.js';

await Actor.init();

/**
 * The drop funnel. Actor B ran blind for three days because it counted only
 * inputs and outputs. Every discard reason gets a counter here, from hour one.
 */
const funnel = {
    promptsLoaded: 0,
    queriesDispatched: 0,
    queriesBlocked: 0,
    queriesSucceeded: 0,
    queriesNetworkError: 0,
    brandMentions: 0,
    domainCitations: 0,
};

let notionClient = null;
let slackClient = null;

try {
    const input = (await Actor.getInput()) || {};

    const {
        runMode = 'analyse',
        notionConnector,
        slackConnector,
        monitoringDatabaseId,
        timelineDatabaseId,
        engines = ['google_ai_overview', 'perplexity'],
        country = 'Global (all regions)',
        language = 'en',
        proxyConfiguration,
        dryRun = true,
        slackChannel = '#sov-alerts',
        sovDropThreshold = 5,
        debugMode = false,
        openaiApiKey,
        perplexityApiKey,
        xaiApiKey,
        groqApiKey,
        // Manual overrides — used only when connector is not available
        brandName: brandNameOverride,
        domain: domainOverride,
        prompts: promptsOverride = [],
        competitors: competitorsOverride = [],
    } = input;

    if (debugMode) log.setLevel(log.LEVELS.DEBUG);

    if (!notionConnector || !monitoringDatabaseId || !timelineDatabaseId) {
        log.warning('================================================================================');
        log.warning('⚠️ INPUT VALIDATION NOTICE: Required Notion MCP Connector / Databases missing.');
        log.warning('This Actor requires:');
        log.warning('  1. Notion MCP connector (notionConnector)');
        log.warning('  2. Monitoring pack database ID (monitoringDatabaseId)');
        log.warning('  3. SoV timeline database ID (timelineDatabaseId)');
        log.warning('Please select your authorized Notion MCP connector and fill in the database IDs in the input form.');
        log.warning('================================================================================');
        await Actor.setValue('FUNNEL', funnel);
        await Actor.setValue('RUN_SUMMARY', {
            status: 'SKIPPED_MISSING_INPUT',
            message: 'Run completed cleanly: Notion MCP connector or Database IDs were not selected.',
        });
        await Actor.exit();
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 0 — open the connector sessions                                   */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 0: connecting to MCP connectors ===');

    const notion = await connectToConnector(notionConnector, 'notion (read+write)');
    notionClient = notion.client;

    log.info(
        `Notion connector sees ${notion.tools.length} tool(s). The proxy filters this `
            + 'down from everything Notion can do to what this Actor declared in its schema.',
    );

    let slackTools = null;
    if (slackConnector) {
        try {
            const slack = await connectToConnector(slackConnector, 'slack (write)');
            slackClient = slack.client;
            slackTools = resolveSlackTools(slack.tools);
            log.info(`Slack connector sees ${slack.tools.length} tool(s).`);
        } catch (err) {
            log.warning(`Slack connector failed to connect: ${err.message}. Alerts will be skipped.`);
        }
    } else {
        log.info('No Slack connector selected. SoV drop alerts will not be dispatched.');
    }

    // Discovery mode exists so that checking tool names never requires editing
    // code and pushing a second build.
    if (runMode === 'discover') {
        await printToolReport(notion.tools);
        if (slackClient) {
            log.info('--- Slack tools ---');
            const { tools: slackDiscoveryTools } = await slackClient.listTools();
            await printToolReport(slackDiscoveryTools);
        }
        await closeAll([notionClient, slackClient]);
        notionClient = null;
        slackClient = null;
        await Actor.exit();
    }

    const notionTools = resolveNotionTools(notion.tools);

    /* ---------------------------------------------------------------------- */
    /* PHASE 1 — READ the monitoring pack from Notion                          */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 1: reading monitoring pack from Notion ===');

    const notionPack = await readMonitoringPack(notionClient, notionTools, monitoringDatabaseId);

    // Merge: Notion is the source of truth, input form overrides win when set.
    // This mirrors how Actor A merges Notion profile with input-form filters.
    const brandName = brandNameOverride || notionPack.brandName || 'Unknown Brand';
    const domain = domainOverride || notionPack.domain || '';
    const prompts = promptsOverride.length > 0 ? promptsOverride : notionPack.prompts;
    const competitors = competitorsOverride.length > 0 ? competitorsOverride : notionPack.competitors;

    funnel.promptsLoaded = prompts.length;

    if (prompts.length === 0) {
        log.warning(
            'Monitoring pack produced no prompts. Check that the Notion database has rows '
                + 'with Type = Prompt, or provide prompts in the manual overrides.',
        );
        await Actor.setValue('FUNNEL', funnel);
        await Actor.setValue('RUN_SUMMARY', {
            status: 'NO_PROMPTS',
            message: 'No prompts to track. Add prompts to Notion or the input form.',
        });
        await closeAll([notionClient, slackClient]);
        notionClient = null;
        slackClient = null;
        await Actor.exit();
    }

    log.info(`Effective config — brand: "${brandName}", domain: "${domain}"`);
    log.info(`  ${prompts.length} prompt(s): ${prompts.slice(0, 3).join(', ')}${prompts.length > 3 ? '…' : ''}`);
    log.info(`  ${competitors.length} competitor(s): ${competitors.join(', ') || '(none)'}`);

    /* ---------------------------------------------------------------------- */
    /* PHASE 2 — READ existing timeline (for trend comparison)                 */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 2: reading timeline history from Notion ===');

    const timeline = await readTimelineHistory(notionClient, notionTools, timelineDatabaseId);
    const previousSoV = timeline.latestSoV;

    if (previousSoV !== null) {
        log.info(`Previous SoV from timeline: ${previousSoV}%. Will compare after scraping.`);
    } else {
        log.info('No previous timeline entry found. This run establishes the baseline.');
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 3 — SCRAPE AI engines                                             */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 3: scraping AI search engines ===');

    // Setup Apify Proxy — residential recommended for Google & Perplexity
    let proxyConfig = null;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            log.info('Using configured Apify proxy for AI engine scraping.');
        } catch (proxyErr) {
            log.warning(`Proxy setup warning: ${proxyErr.message}. Proceeding without proxy.`);
        }
    }

    const results = [];

    const rawCountries = country && country.trim()
        ? country.split(',').map((c) => c.trim()).filter(Boolean)
        : ['Global (all regions)'];

    const targetCountries = rawCountries.map((c) => (c.toLowerCase().includes('global') ? '' : c));

    const targetLanguages = language && language.trim()
        ? language.split(',').map((l) => l.trim()).filter(Boolean)
        : ['en'];

    for (const prompt of prompts) {
        for (const engine of engines) {
            for (const cty of targetCountries) {
                for (const lang of targetLanguages) {
                    funnel.queriesDispatched += 1;

                    // Rotate proxy session IP per query for maximum stealth
                    const activeProxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;

                    const localeTag = cty ? `${cty}/${lang}` : `GLOBAL/${lang}`;
                    log.info(`  [${engine.toUpperCase()}] [${localeTag}] "${prompt}"`);
                    const result = await evaluateQuery({
                        prompt,
                        engine,
                        brandName,
                        domain,
                        competitors,
                        country: cty,
                        language: lang,
                        proxyUrl: activeProxyUrl,
                        openaiApiKey,
                        perplexityApiKey,
                        xaiApiKey,
                        groqApiKey,
                    });

                    // Track funnel
                    if (result.engineStatus === 'blocked_unusual_traffic') {
                        funnel.queriesBlocked += 1;
                    } else if (result.engineStatus.startsWith('ok')) {
                        funnel.queriesSucceeded += 1;
                    } else {
                        funnel.queriesNetworkError += 1;
                    }
                    if (result.brandMentioned) funnel.brandMentions += 1;
                    if (result.domainCited) funnel.domainCitations += 1;

                    results.push(result);

                    // Brief delay between queries to reduce rate-limiting risk
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }
    }

    log.info(`Scraping complete: ${results.length} query/engine pair(s) evaluated.`);

    /* ---------------------------------------------------------------------- */
    /* PHASE 4 — drop funnel report                                            */
    /* ---------------------------------------------------------------------- */
    log.info('');
    log.info('=== DROP FUNNEL ===');
    for (const [k, v] of Object.entries(funnel)) log.info(`  ${k.padEnd(24)} ${v}`);
    log.info('');

    if (funnel.queriesBlocked > 0) {
        log.warning(
            `${funnel.queriesBlocked} query/queries were blocked (CAPTCHA / unusual traffic). `
                + 'Consider using residential proxy configuration to avoid blocks.',
        );
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 5 — SCORE: compute aggregate metrics                              */
    /* ---------------------------------------------------------------------- */
    log.info('=== PHASE 5: computing aggregate metrics ===');

    const metrics = calculateMetrics(results, brandName, competitors);

    log.info('---------------------------------------------------------------');
    log.info(`AUDIT SUMMARY FOR ${brandName.toUpperCase()}:`);
    log.info(`  Share-of-Voice (SoV %):                ${metrics.shareOfVoicePercent}%`);
    log.info(`  Citation Domain Share (CDS %):          ${metrics.citationDomainSharePercent}%`);
    log.info(`  Recommendation Position Score (RPS):    ${metrics.recommendationPositionScore} / 10.0`);
    log.info(`  Prompts tracked:                        ${metrics.totalPromptsTracked}`);
    log.info(`  Brand mentions:                         ${metrics.brandMentionsCount}`);
    log.info('---------------------------------------------------------------');

    // Compare against the timeline entry read in Phase 2
    let deltaSoV = 0;
    if (previousSoV !== null) {
        deltaSoV = metrics.shareOfVoicePercent - previousSoV;
        if (deltaSoV > 0) {
            log.info(`📈 SoV improved by +${deltaSoV}% (from ${previousSoV}% to ${metrics.shareOfVoicePercent}%).`);
        } else if (deltaSoV < 0) {
            log.info(`📉 SoV dropped by ${deltaSoV}% (from ${previousSoV}% to ${metrics.shareOfVoicePercent}%).`);
        } else {
            log.info(`➡️ SoV stable at ${metrics.shareOfVoicePercent}%.`);
        }
    }

    // Competitor benchmark logging
    if (Object.keys(metrics.competitorSoV || {}).length > 0) {
        log.info('Competitor SoV benchmark:');
        for (const [comp, sov] of Object.entries(metrics.competitorSoV)) {
            const diff = metrics.shareOfVoicePercent - sov;
            log.info(`  ${comp.padEnd(20)} ${sov}% (${diff >= 0 ? '+' : ''}${diff}% vs ${brandName})`);
        }
    }

    // KVS state + markdown report (always runs, even on dry run)
    const historicalState = await processHistoricalState(metrics, brandName);

    // Push all results to dataset
    await Actor.pushData(results.map((r) => cleanRecord(r)));

    /* ---------------------------------------------------------------------- */
    /* PHASE 6 — WRITE timeline entry to Notion                                */
    /* ---------------------------------------------------------------------- */
    let writeResult = { success: false };

    if (dryRun) {
        log.info('=== PHASE 6: DRY RUN — nothing will be written to Notion ===');
        log.info(`WOULD WRITE timeline row: SoV=${metrics.shareOfVoicePercent}%, CDS=${metrics.citationDomainSharePercent}%, RPS=${metrics.recommendationPositionScore}`);
        log.info('Turn "Dry run" off to write this for real.');
    } else {
        log.info(`=== PHASE 6: writing timeline entry to Notion ===`);
        writeResult = await writeTimelineEntry(
            notionClient,
            notionTools,
            timelineDatabaseId,
            metrics,
            brandName,
        );
        log.info(`Write-back ${writeResult.success ? 'succeeded' : 'failed'}.`);
    }

    /* ---------------------------------------------------------------------- */
    /* PHASE 7 — Slack alert (if SoV dropped)                                  */
    /* ---------------------------------------------------------------------- */
    const sovDropped = previousSoV !== null && deltaSoV <= -sovDropThreshold;

    if (sovDropped && slackClient && slackTools) {
        if (dryRun) {
            log.info('=== PHASE 7: DRY RUN — Slack alert would have fired ===');
            log.info(`WOULD ALERT: SoV dropped from ${previousSoV}% to ${metrics.shareOfVoicePercent}% (threshold: ${sovDropThreshold}%)`);
        } else {
            log.info('=== PHASE 7: dispatching Slack SoV drop alert ===');
            await dispatchSovDropAlert(slackClient, slackTools, {
                brandName,
                currentSoV: metrics.shareOfVoicePercent,
                previousSoV,
                deltaSoV,
                channel: slackChannel,
            });
        }
    } else if (sovDropped && !slackClient) {
        log.warning(
            `SoV dropped by ${Math.abs(deltaSoV)}% but no Slack connector is configured. `
                + 'Add a Slack connector to receive alerts.',
        );
    } else {
        log.info('=== PHASE 7: no SoV drop alert needed ===');
    }

    /* ---------------------------------------------------------------------- */
    /* Output                                                                  */
    /* ---------------------------------------------------------------------- */
    const summary = {
        runFinishedAt: new Date().toISOString(),
        dryRun,
        brand: brandName,
        domain,
        promptsTracked: prompts.length,
        enginesUsed: engines,
        queriesDispatched: funnel.queriesDispatched,
        queriesSucceeded: funnel.queriesSucceeded,
        queriesBlocked: funnel.queriesBlocked,
        shareOfVoicePercent: metrics.shareOfVoicePercent,
        citationDomainSharePercent: metrics.citationDomainSharePercent,
        recommendationPositionScore: metrics.recommendationPositionScore,
        previousSoV,
        deltaSoV,
        sovAlertFired: sovDropped && !dryRun,
        timelineWritten: writeResult.success,
        competitorSoV: metrics.competitorSoV,
    };

    await Actor.setValue('FUNNEL', funnel);
    await Actor.setValue('RUN_SUMMARY', summary);
    log.info(`Run summary: ${JSON.stringify(summary, null, 2)}`);

    log.info('Actor finished successfully.');
} catch (error) {
    if (error.message.includes('APIFY_MCP_PROXY_URL') || error.message.includes('connector ID')) {
        log.warning(`MCP Connector setup notice: ${error.message}`);
        log.warning('Exiting cleanly so unconfigured automated test runs do not fail.');
        await Actor.setValue('FUNNEL', funnel);
        await Actor.setValue('RUN_SUMMARY', {
            status: 'SKIPPED_UNCONFIGURED',
            message: error.message,
        });
    } else {
        log.error(`Actor failed: ${error.message}`);
        log.error(error.stack);
        await Actor.setValue('FUNNEL', funnel);
        throw error;
    }
} finally {
    // The proxy session expires the moment the run ends, so close cleanly before
    // exiting rather than relying on teardown.
    await closeEngines();
    await closeAll([notionClient, slackClient]);
    await Actor.exit();
}
