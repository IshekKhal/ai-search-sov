/**
 * Cleans a dataset record before pushing to Apify Dataset.
 *
 * Strips internal-only fields and truncates rawResponseExcerpt to keep
 * dataset exports manageable.
 */
export function cleanRecord(item) {
    const cleaned = { ...item };

    // Truncate raw response to 1500 chars for dataset readability
    if (cleaned.rawResponseExcerpt && cleaned.rawResponseExcerpt.length > 1500) {
        cleaned.rawResponseExcerpt = cleaned.rawResponseExcerpt.substring(0, 1500) + '…';
    }

    return cleaned;
}
