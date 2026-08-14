/**
 * Slack MCP connector module.
 *
 * Dispatches structured alert cards to a Slack channel when Share-of-Voice
 * drops below a threshold. Uses the Slack MCP connector through the Apify
 * proxy — the Actor never sees the user's Slack token.
 */

import { log } from 'apify';
import { resolveTool, callTool } from './mcpClient.js';

/**
 * Resolves the Slack tool names from whatever the proxy exposes.
 */
export function resolveSlackTools(tools) {
    return {
        sendMessage: resolveTool(
            tools,
            ['slack_send_message', 'slack-send-message', '*send*message*', '*post*message*'],
            'send Slack message',
        ),
    };
}

/**
 * Dispatches a Share-of-Voice drop alert to Slack.
 *
 * Only fires if the SoV delta is worse than the threshold (default -5%).
 * This prevents alert fatigue from minor run-to-run variance.
 *
 * @param {Client} client MCP client connected to Slack.
 * @param {object} toolNames Resolved tool names.
 * @param {object} params Alert parameters.
 * @param {string} params.brandName Target brand.
 * @param {number} params.currentSoV Current SoV%.
 * @param {number} params.previousSoV Previous SoV%.
 * @param {number} params.deltaSoV Delta (current - previous).
 * @param {string} params.channel Slack channel to post to.
 */
export async function dispatchSovDropAlert(client, toolNames, {
    brandName,
    currentSoV,
    previousSoV,
    deltaSoV,
    channel = '#sov-alerts',
}) {
    const message = [
        `📉 *Share-of-Voice Drop Alert: ${brandName}*`,
        '',
        `SoV dropped from *${previousSoV}%* to *${currentSoV}%* (${deltaSoV > 0 ? '+' : ''}${deltaSoV}%)`,
        '',
        `This means fewer AI search engines are recommending ${brandName} than in the previous run.`,
        '',
        `_Sent by Apify Actor \`ishekofficial/ai-search-sov-monitor\`_`,
    ].join('\n');

    try {
        await callTool(client, toolNames.sendMessage, {
            channel,
            text: message,
        });
        log.info(`Slack alert dispatched to ${channel}.`);
    } catch (err) {
        log.warning(`Failed to dispatch Slack alert: ${err.message}`);
    }
}
