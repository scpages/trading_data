/**
 * Number Formatting Utilities
 */

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

/**
 * Escape a string for safe interpolation into HTML text or an HTML attribute.
 * Anything that arrives from the UEX API (terminal names, commodity names,
 * container sizes, system codes, etc.) must pass through this before being
 * placed into a template string, since UEX data is community-submitted and
 * cannot be trusted to be free of `<`, `>`, `"`, or `&`.
 * @param {*} value - Value to escape (coerced to string; nullish becomes '')
 * @returns {string}
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
}

const HTML_UNESCAPE_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&#39;': '\'' };

/**
 * Decode HTML entities UEX has occasionally baked directly into a field's
 * raw value (e.g. a manufacturer's company_name arriving as literal
 * "Grey&apos;s Market" instead of "Grey's Market"). Without this, escapeHtml
 * would double-escape the already-encoded "&", rendering "Grey&amp;apos;s
 * Market" on the page. Only handles the small fixed set of entities
 * escapeHtml itself produces - not a general-purpose HTML decoder.
 * @param {*} value - Value to decode (coerced to string; nullish becomes '')
 * @returns {string}
 */
function decodeHtmlEntities(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&(amp|lt|gt|quot|apos|#39);/g, m => HTML_UNESCAPE_MAP[m]);
}

/**
 * Format number with thousand separators
 * @param {number|string} num - Number to format
 * @returns {string} Formatted number
 */
function readable_number(num) {
    if (num === '-') return num;
    return new Intl.NumberFormat('en-US', { useGrouping: true })
        .format(num)
        .replace(/,/g, ' ');
}

/**
 * Classify how stale a UEX `date_modified` timestamp is
 * @param {number} unixTimestampSeconds - Unix timestamp (seconds) from the API
 * @param {Object} thresholds - Staleness thresholds in minutes
 * @param {number} thresholds.stale - Age after which data is considered stale
 * @param {number} thresholds.veryStale - Age after which data is considered very stale
 * @returns {'fresh'|'stale'|'very-stale'} Staleness level
 */
function getStalenessLevel(unixTimestampSeconds, thresholds) {
    if (!unixTimestampSeconds) return 'fresh';
    const ageMinutes = (Date.now() - (unixTimestampSeconds * 1000)) / 60000;
    if (ageMinutes > thresholds.veryStale) return 'very-stale';
    if (ageMinutes > thresholds.stale) return 'stale';
    return 'fresh';
}

/**
 * Confidence multiplier for how much to trust a route built from data this
 * old. Used by Smart Routes (docs/smart-routes-plan.md M2) to discount
 * profit estimates so month-old ghost quotes don't dominate the ranking.
 * Deliberately more aggressive than getStalenessLevel's thresholds/tiers:
 * a missing timestamp gets the *lowest* confidence here (there's no reason
 * to trust data we can't even date), whereas getStalenessLevel treats a
 * missing timestamp as fresh for the main commodity table's purposes.
 * @param {number} unixTimestampSeconds - Unix timestamp (seconds) from the API
 * @returns {number} 0.05 - 1.0
 */
function dataAgeConfidence(unixTimestampSeconds) {
    if (!unixTimestampSeconds) return 0.05;
    const ageDays = (Date.now() - unixTimestampSeconds * 1000) / (24 * 60 * 60 * 1000);
    if (ageDays < 1) return 1.0;
    if (ageDays < 7) return 0.7;
    if (ageDays < 30) return 0.3;
    return 0.05;
}

/**
 * Format a UEX unix timestamp (seconds) as a readable UTC date/time in
 * Slovak locale conventions (d. M. yyyy HH:mm, 24-hour).
 * @param {number} unixTimestampSeconds - Unix timestamp (seconds) from the API
 * @returns {string} Formatted date/time, or 'Unknown' if not available
 */
function formatDateTime(unixTimestampSeconds) {
    if (!unixTimestampSeconds) return 'Unknown';
    return new Date(unixTimestampSeconds * 1000).toLocaleString('sk-SK', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }) + ' UTC';
}

/**
 * UEX stock status is an 8-tier scale (0-7). 0 means out of stock (no estimate
 * possible); 7 is treated as effectively full (100%). The rest are spaced
 * linearly between them, so tier N represents N/7 of capacity.
 */
const STOCK_STATUS_MAX_TIER = 7;

/**
 * Estimate a terminal's max SCU capacity from its current stock and stock status tier.
 * Returns 0 when there is no meaningful signal (no stock, or status = 0 meaning
 * "unknown"); callers should treat 0 as "don't render a max," not as "capacity is
 * zero." The display layer already hides the `/ max` suffix when this is 0, so
 * rows with no signal simply omit the estimate rather than fabricating one.
 * @param {number} currentStock - Current SCU stock (scu_sell_stock or scu_buy)
 * @param {number} status - UEX stock status tier (0-7)
 * @returns {number}
 */
function estimateMaxInventory(currentStock, status) {
    if (!currentStock) return 0;
    if (!status) return 0;
    const fraction = Math.min(status, STOCK_STATUS_MAX_TIER) / STOCK_STATUS_MAX_TIER;
    return Math.round(currentStock / fraction);
}

const STOCK_USAGE_LOW = 0.30;
const STOCK_USAGE_HIGH = 0.70;

/**
 * Pick a subtle color class for a terminal's stock cell based on fill fraction.
 * Only applied to fresh rows (older data is already grayed out and shouldn't
 * pull the eye with additional colour cues).
 *
 * Buy side (player buys from terminal):
 *  - low stock  = orange (competitive - other players are draining stock)
 *  - high stock = green  (plenty available to buy)
 * Sell side (player sells to terminal):
 *  - low stock  = green  (terminal has room to buy from you)
 *  - high stock = red    (terminal maxed out, can't accept more)
 *
 * @param {number} stock - Current SCU in the terminal
 * @param {number} max - Estimated or confirmed max SCU capacity
 * @param {'buy'|'sell'} side - Which side of the trade this row represents
 * @param {'fresh'|'stale'|'very-stale'} staleness - Data freshness classification
 * @returns {string} CSS class name, or empty string for no colouring
 */
function getStockUsageClass(stock, max, side, staleness) {
    if (staleness !== 'fresh') return '';
    if (!max || max <= 0) return '';

    const fraction = stock / max;
    if (side === 'buy') {
        if (fraction <= STOCK_USAGE_LOW) return 'stock-orange';
        if (fraction >= STOCK_USAGE_HIGH) return 'stock-green';
    } else if (side === 'sell') {
        if (fraction <= STOCK_USAGE_LOW) return 'stock-green';
        if (fraction >= STOCK_USAGE_HIGH) return 'stock-red';
    }
    return '';
}

/**
 * Format a UEX `container_sizes` string into a readable SCU box size list
 * @param {string} containerSizes - Comma-separated SCU box sizes, e.g. "1,2,4,8,16,24,32"
 * @returns {string} Formatted list, e.g. "1, 2, 4, 8, 16, 24, 32 SCU", or 'Unknown' if not available
 */
function formatContainerSizes(containerSizes) {
    if (!containerSizes) return 'Unknown';
    return containerSizes.split(',').join(', ') + ' SCU';
}

module.exports = {
    readable_number,
    getStalenessLevel,
    formatDateTime,
    formatContainerSizes,
    estimateMaxInventory,
    escapeHtml,
    decodeHtmlEntities,
    getStockUsageClass,
    dataAgeConfidence
};
