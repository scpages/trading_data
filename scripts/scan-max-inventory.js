/**
 * Max Inventory History Scanner
 *
 * Standalone script that scans UEX commodity price history to find the
 * highest SCU stock ever observed per terminal+commodity pair, and persists
 * the results to max_inventory.json for the server to read on startup.
 *
 * Runs to completion (one full pass) and exits - intended to run in the
 * scheduled GitHub Action that commits the resulting max_inventory.json
 * back to the repo, not inside the running server, so this slow scan
 * never competes with serving live traffic.
 *
 * Always does a fresh full pass regardless of the previously-persisted
 * scan state, so new stock highs and newly-added terminals get picked
 * up on every run.
 */

const logger = require('./logger.js');
const DataCache = require('./dataCache.js');
const trading = require('./services/trading.js');
const { loadConfig } = require('./config.js');

const PROGRESS_LOG_INTERVAL = 20;

// If more than this fraction of per-pair fetches fail (UEX outage, rate
// limit, network blip mid-run), the resulting scan is unreliable enough
// that we'd rather fail the CI run than commit an incomplete file.
const MAX_ACCEPTABLE_FAILURE_RATE = 0.1;

async function main() {
    const config = loadConfig();
    logger.info('Configuration file loaded successfully');

    const cache = new DataCache();

    const gameVersion = await trading.fetchLiveGameVersion(config);
    cache.setGameVersion(gameVersion);
    logger.info(`Live game version: ${gameVersion || 'unknown'}`);

    // Load any prior data so a partial-progress file (from an interrupted
    // previous run) at least preserves the confirmed maxes we've already seen -
    // new-scan results will overwrite existing keys with the fresh value.
    // Cursor and complete flag get reset so this run does a full pass.
    trading.loadConfirmedMaxInventory(cache, config);
    cache.setMaxInventoryCursor(0);
    cache.setMaxInventoryScanComplete(false);
    logger.info('Starting fresh full pass');

    logger.info('Fetching commodity price data to determine scan scope...');
    await trading.refreshData(config, cache);

    let batches = 0;
    let totalFailures = 0;
    let progress;

    do {
        progress = await trading.refreshConfirmedMaxInventory(config, cache);
        batches += 1;
        totalFailures += progress.failures;

        if (batches % PROGRESS_LOG_INTERVAL === 0) {
            logger.info(`Scan progress: ${progress.cursor} / ${progress.total} (failures: ${totalFailures})`);
        }
    } while (!progress.complete);

    const failureRate = progress.total > 0 ? totalFailures / progress.total : 0;
    if (failureRate > MAX_ACCEPTABLE_FAILURE_RATE) {
        logger.error(
            `Max inventory scan finished but ${totalFailures} of ${progress.total} pairs ` +
            `failed to fetch (${(failureRate * 100).toFixed(1)}% > ${(MAX_ACCEPTABLE_FAILURE_RATE * 100).toFixed(0)}% threshold). ` +
            'Refusing to treat this run as authoritative - do not commit max_inventory.json from this run.'
        );
        return 1;
    }

    if (totalFailures > 0) {
        logger.warn(`Max inventory scan finished with ${totalFailures} of ${progress.total} pairs failed (below threshold)`);
    } else {
        logger.info('Max inventory scan finished');
    }
    return 0;
}

main()
    .then(code => process.exit(code))
    .catch(error => {
        logger.error('Max inventory scan failed:', error);
        process.exit(1);
    });
