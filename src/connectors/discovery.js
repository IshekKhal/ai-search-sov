/**
 * Tool discovery mode.
 *
 * Selecting runMode = 'discover' in the input prints every tool the connector
 * exposes, then exits without scraping anything. This exists so that checking
 * tool names never requires editing package.json and pushing a second build.
 */

import { log } from 'apify';

/**
 * Prints every tool available on the connected MCP server.
 *
 * @param {Array} tools Result of client.listTools().
 */
export async function printToolReport(tools) {
    log.info('');
    log.info('=== MCP TOOL DISCOVERY REPORT ===');
    log.info(`${tools.length} tool(s) available through this connector:`);
    log.info('');

    for (const tool of tools) {
        log.info(`  ${tool.name}`);
        if (tool.description) {
            log.info(`    Description: ${tool.description}`);
        }
        if (tool.inputSchema) {
            const required = tool.inputSchema.required || [];
            const props = Object.keys(tool.inputSchema.properties || {});
            log.info(`    Parameters: ${props.join(', ') || '(none)'}`);
            if (required.length) {
                log.info(`    Required:   ${required.join(', ')}`);
            }
        }
        log.info('');
    }

    log.info('=== END DISCOVERY ===');
    log.info('Set runMode back to "analyse" for a real run.');
}
