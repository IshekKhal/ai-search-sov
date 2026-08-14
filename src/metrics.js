/**
 * Metrics Module for AI Search Share-of-Voice Monitor
 * Calculates Share-of-Voice (SoV %), Citation Domain Share (CDS %),
 * Recommendation Position Score (RPS), and Competitor SoV Benchmarks.
 */

export function calculateMetrics(results = [], targetBrand, competitorBrands = []) {
    const totalPrompts = results.length;
    if (totalPrompts === 0) {
        return {
            shareOfVoicePercent: 0,
            citationDomainSharePercent: 0,
            recommendationPositionScore: 0,
            topSourceDomains: [],
            competitorSoV: {}
        };
    }

    let brandMentionsCount = 0;
    let domainCitationsCount = 0;
    let totalPositionPoints = 0;

    const domainFrequency = {};
    const competitorMentions = {};

    for (const comp of competitorBrands) {
        competitorMentions[comp] = 0;
    }

    for (const item of results) {
        if (item.brandMentioned) {
            brandMentionsCount++;
        }

        if (item.domainCited) {
            domainCitationsCount++;
        }

        // RPS Rank Points calculation
        if (item.recommendationRank === 1) {
            totalPositionPoints += 10;
        } else if (item.recommendationRank === 2 || item.recommendationRank === 3) {
            totalPositionPoints += 7;
        } else if (item.recommendationRank !== null) {
            totalPositionPoints += 4;
        }

        // Aggregate source domain frequency
        if (Array.isArray(item.citedDomains)) {
            for (const dom of item.citedDomains) {
                domainFrequency[dom] = (domainFrequency[dom] || 0) + 1;
            }
        }

        // Competitor counts
        if (Array.isArray(item.competitorsFound)) {
            for (const comp of item.competitorsFound) {
                if (competitorMentions[comp] !== undefined) {
                    competitorMentions[comp]++;
                }
            }
        }
    }

    // Top Source Domains sorting
    const sortedDomains = Object.entries(domainFrequency)
        .map(([domain, count]) => ({
            domain,
            count,
            sharePercent: Math.round((count / totalPrompts) * 100)
        }))
        .sort((a, b) => b.count - a.count);

    // Competitor SoV % calculation
    const competitorSoV = {};
    for (const comp of competitorBrands) {
        competitorSoV[comp] = Math.round(((competitorMentions[comp] || 0) / totalPrompts) * 100);
    }

    return {
        totalPromptsTracked: totalPrompts,
        brandMentionsCount,
        domainCitationsCount,
        shareOfVoicePercent: Math.round((brandMentionsCount / totalPrompts) * 100),
        citationDomainSharePercent: Math.round((domainCitationsCount / totalPrompts) * 100),
        recommendationPositionScore: parseFloat((totalPositionPoints / totalPrompts).toFixed(1)),
        topSourceDomains: sortedDomains,
        competitorSoV
    };
}
