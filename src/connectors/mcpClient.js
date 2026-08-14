/**
 * Thin wrapper around the official MCP SDK for talking to the Apify MCP Proxy.
 *
 * Adapted from Actor A (government-tender-monitor) and Actor B (dependency-
 * signal-monitor), with the lessons both paid for in lost days:
 *
 *   1. APIFY_MCP_PROXY_URL is a private address injected only on Apify-hosted
 *      runs. MCP connectors DO NOT WORK under local `apify run`. Deploy first,
 *      then run in Console. This cost Actor A an entire day.
 *   2. The Actor authenticates to the proxy with its own APIFY_TOKEN. It never
 *      sees the user's Notion or Slack credential; the proxy injects it
 *      server-side before forwarding upstream.
 *   3. The proxy session dies with the run. All connector work must finish
 *      before Actor.exit().
 *   4. tools/list is filtered by the proxy down to what this Actor declared in
 *      INPUT_SCHEMA.json. The list you get back is the *effective* permission
 *      set, not everything Notion/Slack can do.
 *   5. callTool inspects the *payload* for usage-limit refusals, not just the
 *      transport layer. Notion returns HTTP 200 and refuses inside the result
 *      body. Actor B discovered this on day two.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from 'apify';

/**
 * Opens an MCP session to one connector through the Apify proxy.
 *
 * @param {string} connectorId Connector ID from the Actor input.
 * @param {string} label Human-readable name, used only for logging.
 * @returns {Promise<{client: Client, tools: Array}>}
 */
export async function connectToConnector(connectorId, label = 'connector') {
    const proxyUrl = process.env.APIFY_MCP_PROXY_URL;
    const token = process.env.APIFY_TOKEN;

    if (!proxyUrl) {
        throw new Error(
            'APIFY_MCP_PROXY_URL is missing. MCP connectors only work on Apify-hosted '
                + 'runs. This variable is not injected during a local `apify run`, so deploy '
                + 'the Actor and run it in Console instead.',
        );
    }
    if (!connectorId) {
        throw new Error(
            `No connector ID supplied for "${label}". Select a connector in the input form.`,
        );
    }

    const transport = new StreamableHTTPClientTransport(
        new URL(`${proxyUrl}/${connectorId}`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );

    const client = new Client({ name: 'ai-search-sov-monitor', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();

    log.info(
        `[${label}] connected. ${tools.length} tool(s) permitted: ${tools
            .map((t) => t.name)
            .join(', ')}`,
    );

    if (tools.length === 0) {
        log.warning(
            `[${label}] the proxy permitted ZERO tools. This is almost never a token `
                + 'problem. It means no mcpServers rule in INPUT_SCHEMA.json matched, or a '
                + 'behavioural hint excluded everything.',
        );
    }

    return { client, tools };
}

/**
 * Finds the first available tool whose name matches one of the candidate
 * patterns, in priority order.
 *
 * MCP servers rename their tools without warning. Hardcoding a tool name is
 * how this Actor breaks silently three months from now. Resolve at runtime,
 * fail loudly with the full list of what IS available.
 *
 * @param {Array} tools Result of client.listTools().
 * @param {string[]} patterns Glob-ish patterns, '*' matches any characters.
 * @param {string} purpose Description used in the error message.
 * @returns {string} The resolved tool name.
 */
export function resolveTool(tools, patterns, purpose) {
    const names = tools.map((t) => t.name);

    for (const pattern of patterns) {
        const rx = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
        const hit = names.find((n) => rx.test(n));
        if (hit) {
            log.debug(`Resolved ${purpose} -> "${hit}" (matched pattern "${pattern}")`);
            return hit;
        }
    }

    throw new Error(
        `Could not resolve a tool for "${purpose}".\n`
            + `  Tried patterns : ${patterns.join(', ')}\n`
            + `  Tools available: ${names.join(', ') || '(none)'}\n`
            + 'If the tool list is empty, no mcpServers rule matched. If non-empty '
            + 'but nothing matched, the upstream server renamed its tools: re-run '
            + 'with runMode = "discover" and update the patterns.',
    );
}

/**
 * Phrases that mean "the upstream server refused" while the transport reported
 * success. Notion meters its best read tool and refuses mid-run as a tool
 * *result*, not as an error. res.isError is false. Actor B learned this the
 * hard way.
 */
const REFUSAL_PATTERNS = [
    /rate limit/i,
    /rate.?limited/i,
    /usage limit/i,
    /quota/i,
    /too many requests/i,
    /exceeded/i,
    /api limit/i,
];

/**
 * Calls a tool and returns its parsed payload.
 *
 * MCP responses come back as a content array. Servers vary in whether they
 * populate structuredContent or stuff JSON into a text block, so handle both.
 *
 * @param {Client} client
 * @param {string} name Tool name.
 * @param {object} args Tool arguments.
 * @param {{ tolerateRefusal?: boolean }} [opts]
 * @returns {Promise<any>}
 */
export async function callTool(client, name, args, opts = {}) {
    const res = await client.callTool({ name, arguments: args });

    const asText = (res.content || [])
        .map((c) => c.text ?? JSON.stringify(c))
        .join(' ');

    if (res.isError) {
        throw new Error(`Tool "${name}" returned an error: ${asText}`);
    }

    // Refusal-in-payload check. Only short payloads — a legitimate 40 KB file
    // listing that happens to contain the word "quota" is not a refusal.
    if (asText && asText.length < 600 && REFUSAL_PATTERNS.some((rx) => rx.test(asText))) {
        if (opts.tolerateRefusal) {
            log.warning(`Tool "${name}" refused in payload: ${asText.trim()}`);
            return null;
        }
        throw new Error(`Tool "${name}" reported success but refused in its payload: ${asText.trim()}`);
    }

    if (res.structuredContent) return res.structuredContent;

    const textBlock = (res.content || []).find((c) => c.type === 'text');
    if (!textBlock) return res.content;

    try {
        return JSON.parse(textBlock.text);
    } catch {
        return textBlock.text;
    }
}

/** Closes clients without letting one failure mask the others. */
export async function closeAll(clients) {
    await Promise.allSettled(
        clients.filter(Boolean).map(async (c) => {
            try {
                await c.close();
            } catch (err) {
                log.warning(`Failed to close an MCP client cleanly: ${err.message}`);
            }
        }),
    );
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
