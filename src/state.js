import { Actor, log } from 'apify';

/**
 * State Module for AI Search Share-of-Voice Monitor
 * Manages Key-Value Store state (`SOV_HISTORICAL_STATE`), computes delta trends,
 * and generates formatted Markdown reports (`OUTPUT_REPORT.md`).
 */

export async function processHistoricalState(currentSummary, targetBrand) {
    const kvStore = await Actor.openKeyValueStore();
    const stateKey = 'SOV_HISTORICAL_STATE';
    const previousState = await kvStore.getValue(stateKey);

    let deltaSoV = 0;
    let deltaCDS = 0;
    let trendMessage = 'Initial baseline run created.';

    if (previousState && typeof previousState.shareOfVoicePercent === 'number') {
        deltaSoV = currentSummary.shareOfVoicePercent - previousState.shareOfVoicePercent;
        deltaCDS = currentSummary.citationDomainSharePercent - (previousState.citationDomainSharePercent || 0);

        if (deltaSoV > 0) {
            trendMessage = `📈 Share-of-Voice improved by +${deltaSoV}% (from ${previousState.shareOfVoicePercent}% to ${currentSummary.shareOfVoicePercent}%).`;
        } else if (deltaSoV < 0) {
            trendMessage = `📉 Share-of-Voice dropped by ${deltaSoV}% (from ${previousState.shareOfVoicePercent}% to ${currentSummary.shareOfVoicePercent}%).`;
        } else {
            trendMessage = `➡️ Share-of-Voice remained stable at ${currentSummary.shareOfVoicePercent}%.`;
        }

        log.info(trendMessage);
    } else {
        log.info(`No previous historical state found. Baseline established at ${currentSummary.shareOfVoicePercent}% SoV.`);
    }

    const updatedState = {
        lastRunTimestamp: new Date().toISOString(),
        targetBrand,
        metrics: currentSummary,
        deltaFromPreviousRun: {
            deltaSoV,
            deltaCDS,
            trendMessage
        }
    };

    // Save updated historical state
    await kvStore.setValue(stateKey, updatedState);

    // Generate OUTPUT_REPORT.md markdown artifact in Key-Value store
    const markdownReport = generateMarkdownReport(updatedState);
    await kvStore.setValue('OUTPUT_REPORT.md', markdownReport, { contentType: 'text/markdown' });

    return updatedState;
}

function generateMarkdownReport(state) {
    const { targetBrand, metrics, deltaFromPreviousRun, lastRunTimestamp } = state;

    let compTable = '| Competitor | Share-of-Voice |\n| --- | --- |\n';
    if (metrics.competitorSoV) {
        for (const [comp, sov] of Object.entries(metrics.competitorSoV)) {
            compTable += `| ${comp} | ${sov}% |\n`;
        }
    }

    let sourceTable = '| Source Domain | Mentions Count | Share % |\n| --- | --- | --- |\n';
    if (Array.isArray(metrics.topSourceDomains) && metrics.topSourceDomains.length > 0) {
        for (const item of metrics.topSourceDomains.slice(0, 5)) {
            sourceTable += `| ${item.domain} | ${item.count} | ${item.sharePercent}% |\n`;
        }
    } else {
        sourceTable += '| None detected | 0 | 0% |\n';
    }

    return `# AI Search Share-of-Voice Audit Report: ${targetBrand}

_Executed at: ${lastRunTimestamp}_

## Executive Summary
- **Target Brand:** ${targetBrand}
- **Share-of-Voice (SoV %):** **${metrics.shareOfVoicePercent}%**
- **Citation Domain Share (CDS %):** **${metrics.citationDomainSharePercent}%**
- **Recommendation Position Score (RPS):** **${metrics.recommendationPositionScore} / 10.0**
- **Trend Status:** ${deltaFromPreviousRun.trendMessage}

---

## Competitor Share-of-Voice Benchmark
${compTable}

---

## Top Source Domains Powering AI Answers (Citation Attribution)
${sourceTable}

---

_Generated automatically by Apify Actor \`ishekofficial/ai-search-sov-monitor\`._
`;
}
