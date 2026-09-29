/**
 * InfluxDB Max Inventory Enricher
 *
 * Standalone script that enriches max_inventory.json with historical MAX(scu)
 * values from InfluxDB, updating any pair where InfluxDB has a higher value
 * than the UEX scan found.
 *
 * Intended to run as the second step in the GitHub Action, after
 * scan-max-inventory.js has already committed the UEX-sourced baseline.
 *
 * Requires influx config in config.local.json on the runner (gitignored):
 *   { "influx": { "url": "...", "db": "...", "user": "...", "password": "..." } }
 */

const logger = require('./logger.js');
const DataCache = require('./dataCache.js');
const trading = require('./services/trading.js');
const influx = require('./services/influx.js');
const { loadConfig } = require('./config.js');

async function main() {
    const config = loadConfig();
    logger.info('Configuration file loaded successfully');

    if (!config.influx) {
        logger.error('No influx config found — skipping enrichment (add config.local.json on the runner)');
        return 1;
    }

    const cache = new DataCache();

    const gameVersion = await trading.fetchLiveGameVersion(config);
    cache.setGameVersion(gameVersion);
    logger.info(`Live game version: ${gameVersion || 'unknown'}`);

    trading.loadConfirmedMaxInventory(cache, config);
    const before = Object.keys(cache.exportMaxInventoryState().data || {}).length;

    logger.info('Fetching commodity price data for name→ID mapping...');
    await trading.refreshData(config, cache);

    await influx.enrichMaxInventory(cache, config);

    const after = Object.keys(cache.exportMaxInventoryState().data || {}).length;
    logger.info(`Pairs before: ${before}, after: ${after}`);

    trading.saveConfirmedMaxInventory(cache, config);
    logger.info('max_inventory.json updated');
    return 0;
}

main()
    .then(code => process.exit(code))
    .catch(error => {
        logger.error('InfluxDB enrichment failed:', error);
        process.exit(1);
    });
