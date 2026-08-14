/**
 * Notion reads and writes through an Apify MCP connector.
 *
 * Rewritten against the real official Notion MCP tool surface, matching the proven,
 * battle-tested architecture of Actor A.
 *
 * Notion's MCP server does not expose REST-style database querying. Instead, it exposes:
 *   1. `notion-fetch` to resolve a Database ID into a SQLite collection handle.
 *   2. `notion-query-data-sources` to run SQLite queries against that handle.
 *   3. `notion-create-pages` to write new pages.
 *
 * Page properties created/written via `notion-create-pages` are a flat JSON map of
 * column names to scalar values (e.g. { "Brand": "Apify", "SoV": 87 }). Rich REST objects
 * are NOT supported.
 */

import { log } from 'apify';
import { resolveTool, callTool } from './mcpClient.js';

/* Tool name patterns, most specific first. Real names confirmed by discovery. */
const FETCH_PATTERNS = ['notion-fetch', '*fetch*'];
const SQL_PATTERNS = ['notion-query-data-sources', '*query*data*source*'];
const CREATE_PATTERNS = ['notion-create-pages', 'notion-create-page', '*create*page*'];

/**
 * Resolves the Notion tool names from whatever the proxy exposes.
 */
export function resolveNotionTools(tools) {
    return {
        fetch: resolveTool(tools, FETCH_PATTERNS, 'resolving Notion databases'),
        sql: resolveTool(tools, SQL_PATTERNS, 'querying Notion databases'),
        createPages: resolveTool(tools, CREATE_PATTERNS, 'writing pages to Notion'),
    };
}

/**
 * Resolves a database ID into a SQLite data source URL handle.
 */
async function resolveDataSourceUrl(client, tools, databaseId) {
    log.info(`Resolving data source for database ${databaseId} (tool: ${tools.fetch})...`);

    const raw = await callTool(client, tools.fetch, { id: databaseId });
    const text = unwrapText(raw);

    const found = [...text.matchAll(/collection:\/\/[0-9a-f-]{36}/gi)].map((m) => m[0]);
    const unique = [...new Set(found)];

    if (unique.length === 0) {
        throw new Error(
            `notion-fetch returned no data source handle for database "${databaseId}".\n` +
            `  Most likely causes:\n` +
            `    - The ID is a page ID, not a database ID.\n` +
            `    - The database is not shared with the MCP connector.\n` +
            `  First 500 chars of response:\n${text.slice(0, 500)}`
        );
    }

    log.info(`Data source resolved: ${unique[0]}`);
    return { url: unique[0], rawText: text };
}

/**
 * Reads database rows with multiple fallbacks if SQL quota is exceeded.
 */
async function readRowsWithFallback(client, tools, databaseId, source, sql, searchHint = '') {
    // Attempt 1: Run SQL
    try {
        const raw = await callTool(client, tools.sql, {
            data: {
                mode: 'sql',
                data_source_urls: [source.url],
                query: sql,
            },
        });
        const rows = extractRows(raw);
        log.info(`Read ${rows.length} row(s) via SQL.`);
        return { rows, via: 'sql' };
    } catch (err) {
        log.warning(`SQL query failed: ${err.message}. Falling back to parsing raw markdown...`);
    }

    // Attempt 2: Fallback to parsing the markdown fetch response we already have
    const rows = parseRows(source.rawText);
    if (rows.length > 0) {
        log.info(`Read ${rows.length} row(s) via raw markdown parsing fallback.`);
        return { rows, via: 'fetch-markdown' };
    }

    throw new Error(`Could not read rows for database "${databaseId}". All read paths exhausted.`);
}

/**
 * Reads the monitoring pack from a Notion database.
 */
export async function readMonitoringPack(client, tools, databaseId) {
    log.info(`Reading monitoring pack from Notion database ${databaseId}...`);

    const pack = {
        prompts: [],
        brandName: null,
        domain: null,
        competitors: [],
    };

    try {
        const source = await resolveDataSourceUrl(client, tools, databaseId);
        const { rows } = await readRowsWithFallback(
            client,
            tools,
            databaseId,
            source,
            `SELECT * FROM "${source.url}"`,
            'monitoring pack database'
        );

        for (const row of rows) {
            const type = String(pick(row, ['Type', 'type']) || '').trim().toLowerCase();
            const value = String(pick(row, ['Value', 'value', 'Name', 'name', 'Title', 'title']) || '').trim();

            if (!type || !value) continue;

            switch (type) {
                case 'prompt':
                    pack.prompts.push(value);
                    break;
                case 'brand':
                    pack.brandName = value;
                    break;
                case 'domain':
                    pack.domain = value;
                    break;
                case 'competitor':
                    pack.competitors.push(value);
                    break;
                default:
                    log.debug(`Unknown row type "${type}": ${value}`);
            }
        }

        log.info(
            `Monitoring pack from Notion: ${pack.prompts.length} prompt(s), ` +
            `brand="${pack.brandName || '(none)'}", domain="${pack.domain || '(none)'}", ` +
            `${pack.competitors.length} competitor(s).`
        );
    } catch (err) {
        log.warning(`Failed to read monitoring pack from Notion: ${err.message}`);
        log.warning('Falling back to input form overrides.');
    }

    return pack;
}

/**
 * Reads existing timeline entries from the Notion timeline database to build
 * a historical comparison set.
 */
export async function readTimelineHistory(client, tools, databaseId) {
    log.info(`Reading timeline history from Notion database ${databaseId}...`);

    try {
        const source = await resolveDataSourceUrl(client, tools, databaseId);
        const { rows } = await readRowsWithFallback(
            client,
            tools,
            databaseId,
            source,
            `SELECT * FROM "${source.url}"`,
            'timeline history database'
        );

        log.info(`Found ${rows.length} existing timeline entry/entries.`);

        // Extract the most recent SoV by parsing dates locally
        let latestSoV = null;
        let latestDate = null;

        for (const row of rows) {
            const dateStr = pick(row, ['Date', 'date']);
            const sovVal = parseFloat(pick(row, ['SoV', 'sov', 'ShareOfVoice', 'shareofvoice']) || '');

            if (dateStr && !isNaN(sovVal)) {
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    if (!latestDate || date > latestDate) {
                        latestDate = date;
                        latestSoV = sovVal;
                    }
                }
            }
        }

        if (latestSoV !== null) {
            log.info(`Resolved latest SoV: ${latestSoV}% (dated ${latestDate.toISOString().split('T')[0]})`);
        }

        return { entries: rows, latestSoV };
    } catch (err) {
        log.warning(`Failed to read timeline history: ${err.message}`);
        return { entries: [], latestSoV: null };
    }
}

/**
 * Writes a single timeline row to the Notion timeline database using flat properties.
 */
export async function writeTimelineEntry(client, tools, databaseId, metrics, brandName) {
    try {
        log.info(`Writing timeline row to database ${databaseId} using flat properties...`);

        const competitorText = Object.entries(metrics.competitorSoV || {})
            .map(([comp, sov]) => `${comp}: ${sov}%`)
            .join(', ');

        const topDomainsText = (metrics.topSourceDomains || [])
            .slice(0, 5)
            .map((d) => `${d.domain} (${d.count})`)
            .join(', ');

        await callTool(client, tools.createPages, {
            parent: { database_id: databaseId },
            pages: [
                {
                    properties: {
                        'Brand': brandName,
                        'Date': new Date().toISOString().split('T')[0],
                        'SoV': metrics.shareOfVoicePercent,
                        'CDS': metrics.citationDomainSharePercent,
                        'RPS': metrics.recommendationPositionScore,
                        'Prompts Tracked': metrics.totalPromptsTracked,
                        'Brand Mentions': metrics.brandMentionsCount,
                        'Competitor SoV': competitorText || 'None',
                        'Top Citation Sources': topDomainsText || 'None',
                    },
                },
            ],
        });

        log.info('Timeline entry written successfully.');
        return { success: true };
    } catch (err) {
        log.warning(`Failed to write timeline entry: ${err.message}`);
        return { success: false, error: err.message };
    }
}

// --- Internal Helper Functions ---

function unwrapText(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.text === 'string') return parsed.text;
        } catch {
            // plain text
        }
        return raw;
    }
    if (typeof raw.text === 'string') return raw.text;
    if (Array.isArray(raw.content)) {
        return raw.content.map((c) => c.text ?? '').join('\n');
    }
    return JSON.stringify(raw);
}

function extractRows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    for (const key of ['rows', 'results', 'records', 'data', 'items']) {
        if (Array.isArray(raw[key])) return raw[key];
    }
    const parsed = parseRows(unwrapText(raw));
    if (parsed.length) return parsed;
    return [];
}

function parseRows(text) {
    const table = parseMarkdownTable(text);
    if (table.length > 0) return table;
    return parsePageBlocks(text);
}

function parseMarkdownTable(text) {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('|') && l.endsWith('|'));
    if (lines.length < 2) return [];

    const cells = (l) =>
        l
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim());

    const headers = cells(lines[0]);
    const body = lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l)).slice(1);

    return body.map((line) => {
        const vals = cells(line);
        return Object.fromEntries(headers.map((h, i) => [h, coerce(vals[i])]));
    });
}

function parsePageBlocks(text) {
    const blocks = [...text.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/gi)].map((m) => m[1]);
    if (blocks.length === 0) return [];

    const rows = [];
    for (const block of blocks) {
        const row = {};
        for (const line of block.split('\n')) {
            const m = line.match(/^\s*([A-Za-z][\w \-()]*?)\s*:\s*(.*)$/);
            if (!m) continue;
            const [, key, value] = m;
            row[key.trim()] = coerce(value.trim());
        }
        if (Object.keys(row).length > 0) rows.push(row);
    }
    return rows;
}

function coerce(v) {
    if (v == null || v === '' || v === '—' || v === '-') return null;
    if (v === 'true' || v === '✓' || v === 'Yes') return true;
    if (v === 'false' || v === '☐' || v === 'No') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
}

function pick(obj, keys) {
    if (!obj) return null;
    for (const k of keys) {
        if (obj[k] !== undefined) return obj[k];
    }
    return null;
}
