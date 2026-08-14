/**
 * Parser Module for AI Search Share-of-Voice Monitor
 * Performs regex word-boundary brand detection, source domain extraction,
 * recommendation rank parsing, competitor displacement detection, and sentiment vectoring.
 */

/**
 * Escapes regex special characters in a string.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks if target brand is mentioned in the response text, accounting for spacing variations
 * (e.g. "ScraperAPI" vs "Scraper API", "Bright Data" vs "BrightData").
 */
export function parseBrandMention(text, brandName) {
    if (!text || !brandName) return false;
    const cleanBrand = brandName.trim();
    const spacedPattern = escapeRegex(cleanBrand).replace(/\s+/g, '\\s*');
    const regex = new RegExp(`\\b${spacedPattern}\\b`, 'i');
    return regex.test(text);
}

/**
 * Extracts cited source URLs and canonical domain names from markdown links or text footnotes.
 */
export function extractCitationDomains(text) {
    if (!text) return { urls: [], domains: [] };
    const urls = [];
    const domains = new Set();

    // Match markdown links [Text](URL) or plain http(s) URLs
    const urlRegex = /(https?:\/\/[^\s\)\>\]"'`]+)/gi;
    let match;

    while ((match = urlRegex.exec(text)) !== null) {
        let rawUrl = match[1].replace(/[\,\.\)\:;'"\`]+$/, '');
        urls.push(rawUrl);
        try {
            const parsed = new URL(rawUrl);
            let hostname = parsed.hostname.replace(/^www\./, '').replace(/[\,\.\)\:;'"\`]+$/, '');
            if (hostname) domains.add(hostname);
        } catch {
            // Ignore malformed URLs
        }
    }

    return {
        urls,
        domains: Array.from(domains)
    };
}

/**
 * Checks if the target domain appears in extracted citation URLs or text.
 */
export function isDomainCited(citationDomains, text, targetDomain) {
    if (!targetDomain) return false;
    const cleanTarget = targetDomain.toLowerCase().replace(/^www\./, '').trim();
    if (!cleanTarget) return false;

    const domainRoot = cleanTarget.split('.')[0];

    const inDomains = (citationDomains || []).some((d) => d.toLowerCase().includes(cleanTarget));
    const inUrls = (citationDomains || []).some((d) => domainRoot && domainRoot.length > 3 && d.toLowerCase().includes(domainRoot));
    const inText = text ? text.toLowerCase().includes(cleanTarget) : false;

    return inDomains || inUrls || inText;
}

/**
 * Parses the ordered recommendation rank of the target brand (1st, 2nd, 3rd, etc.).
 * Checks numbered items (1., 1), #1) and bulleted list positions (-, *, •).
 */
export function parseRankPosition(text, brandName) {
    if (!text || !brandName) return null;

    const lines = text.split('\n');
    const cleanBrand = brandName.trim();

    let listPosition = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check if line is a numbered item or bullet list item
        const numMatch = line.match(/^(?:#?\s*)?(\d+)[\.\)\:]\s*/);
        const bulletMatch = line.match(/^[\-\*\•]\s*/);

        if (numMatch || bulletMatch) {
            listPosition++;
            if (parseBrandMention(line, cleanBrand)) {
                return numMatch ? parseInt(numMatch[1], 10) : listPosition;
            }
        } else if (parseBrandMention(line, cleanBrand)) {
            // Found line with brand
            const inlineNum = line.match(/(?:rank|position|#|top)\s*(\d+)/i);
            if (inlineNum) return parseInt(inlineNum[1], 10);
        }
    }

    // Fallback heuristic: if mentioned anywhere in text, assign position based on appearance order
    if (parseBrandMention(text, cleanBrand)) {
        return 4; // Mentioned in narrative body
    }

    return null;
}

/**
 * Identifies competitors present in the response and determines if a competitor displaced target brand at #1.
 */
export function parseCompetitors(text, competitorsList = [], targetBrand, targetRank) {
    if (!text) return { competitorsFound: [], displacedByCompetitor: null };

    const competitorsFound = [];
    let displacedByCompetitor = null;

    for (const comp of competitorsList) {
        if (parseBrandMention(text, comp)) {
            competitorsFound.push(comp);
            const compRank = parseRankPosition(text, comp);
            if (compRank === 1 && (targetRank === null || targetRank > 1)) {
                displacedByCompetitor = comp;
            }
        }
    }

    return {
        competitorsFound,
        displacedByCompetitor
    };
}

/**
 * Classifies sentiment and key context tags associated with target brand.
 */
export function classifySentimentAndContext(text, brandName) {
    if (!text || !parseBrandMention(text, brandName)) {
        return { sentiment: 'Omitted', featureContext: [] };
    }

    const lower = text.toLowerCase();
    const positiveKeywords = ['best', 'top', 'leader', 'leading', 'excellent', 'robust', 'powerful', 'recommended', 'fast', 'reliable'];
    const negativeKeywords = ['expensive', 'slow', 'complex', 'steep', 'lacks', 'limited', 'buggy', 'outdated', 'hard to use'];

    let posScore = 0;
    let negScore = 0;
    const featureContext = [];

    for (const kw of positiveKeywords) {
        if (lower.includes(kw)) {
            posScore++;
            if (featureContext.length < 3) featureContext.push(kw);
        }
    }

    for (const kw of negativeKeywords) {
        if (lower.includes(kw)) {
            negScore++;
            if (featureContext.length < 3) featureContext.push(`issues: ${kw}`);
        }
    }

    let sentiment = 'Neutral';
    if (posScore > negScore) sentiment = 'Positive';
    if (negScore > posScore) sentiment = 'Negative';

    return {
        sentiment,
        featureContext
    };
}
