/**
 * Trading Service
 * Business logic for trading data processing and calculations
 */

const fs = require('fs');
const logger = require('../logger.js');
const uexApi = require('./uexApi.js');
const { estimateMaxInventory, decodeHtmlEntities } = require('../utils/formatters.js');

const DEFAULT_MAX_INVENTORY_FILE = './max_inventory.json';
const DEFAULT_TERMINAL_DISTANCES_FILE = './terminals_distances.json';

/**
 * Resolve a configurable data file path, falling back to its hardcoded
 * default when config or config.data_files doesn't have the key - keeps
 * this backward compatible with any host's config.json that predates
 * this option (config.json is gitignored and deployed separately per host,
 * so it can lag behind what's in config.json.example).
 * @param {Object} config - Configuration object (may be undefined)
 * @param {string} key - Key under config.data_files
 * @param {string} fallback - Default path
 * @returns {string}
 */
function resolveDataFile(config, key, fallback) {
    return config?.data_files?.[key] || fallback;
}

/**
 * Normalize price data to numbers with validation
 * @param {Object} item - Data item to normalize
 */
function normalizeDataItem(item) {
    // Convert to numbers, defaulting to 0 if invalid
    item.price_buy = Number(item.price_buy) || 0;
    item.price_buy_avg = Number(item.price_buy_avg) || 0;
    item.price_sell = Number(item.price_sell) || 0;
    item.price_sell_avg = Number(item.price_sell_avg) || 0;
    item.scu_buy = Number(item.scu_buy) || 0;
    item.scu_buy_avg = Number(item.scu_buy_avg) || 0;
    item.scu_sell_stock = Number(item.scu_sell_stock) || 0;
    item.scu_sell_stock_avg = Number(item.scu_sell_stock_avg) || 0;
    item.scu_sell = Number(item.scu_sell) || 0;
    item.scu_sell_avg = Number(item.scu_sell_avg) || 0;

    // Ensure no negative values
    Object.keys(item).forEach(key => {
        if (key.startsWith('price_') || key.startsWith('scu_')) {
            if (item[key] < 0) item[key] = 0;
        }
    });
}

/**
 * Refresh commodity price data from API
 * @param {Object} config - Configuration object
 * @param {Object} cache - DataCache instance
 * @returns {Promise<void>}
 */
async function refreshData(config, cache) {
    try {
        logger.info('Refreshing commodity data from UEX API...');
        const resp = await uexApi.fetchPrices(config);

        if (!resp || !Array.isArray(resp.data)) {
            throw new Error('Invalid API response structure');
        }

        if (resp.data.length === 0) {
            logger.warn('API returned empty data set');
        }

        resp.data.forEach(normalizeDataItem);
        cache.setData(resp);

        logger.info(`Data refreshed successfully (${resp.data.length} commodities)`);
    } catch (error) {
        logger.error('Failed to refresh data:', error);
        throw error;
    }
}

const CONFIRMED_MAX_BATCH_SIZE = 10;

/**
 * Fetch the current live Star Citizen game version
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} The live version string, or null if unavailable
 */
async function fetchLiveGameVersion(config) {
    try {
        const resp = await uexApi.fetchGameVersion(config);
        return resp?.data?.live || null;
    } catch (error) {
        logger.warn(`Failed to fetch live game version: ${error.message}`);
        return null;
    }
}

/**
 * Load previously scanned confirmed max inventory data from disk, if present.
 * Discarded if it was scanned on a different game version than cache.getGameVersion(),
 * since a patch can change terminal capacities/locations and invalidate old data.
 * @param {Object} cache - DataCache instance (must have its game version set first)
 * @param {Object} [config] - Configuration object (for data_files.max_inventory override)
 */
function loadConfirmedMaxInventory(cache, config) {
    const file = resolveDataFile(config, 'max_inventory', DEFAULT_MAX_INVENTORY_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('No saved max inventory data found, will scan from scratch');
        } else {
            logger.warn(`Could not read ${file}, will scan from scratch: ${error.message}`);
        }
        return;
    }

    let state;
    try {
        state = JSON.parse(raw);
    } catch (error) {
        logger.warn(`Saved max inventory data is corrupted, will scan from scratch: ${error.message}`);
        return;
    }

    const currentVersion = cache.getGameVersion();

    if (currentVersion && state.gameVersion && state.gameVersion !== currentVersion) {
        logger.info(`Discarding saved max inventory data (scanned on game version ${state.gameVersion}, current live version is ${currentVersion})`);
        return;
    }

    cache.importMaxInventoryState(state);
    if (!currentVersion && state.gameVersion) {
        // Couldn't verify the live version this run (e.g. API unavailable) - keep the
        // file's existing tag instead of losing it to a null on the next save.
        cache.setGameVersion(state.gameVersion);
    }

    const pairCount = Object.keys(state.data || {}).length;
    logger.info(`Loaded confirmed max inventory from disk (${pairCount} pairs, cursor ${state.cursor || 0}, complete=${!!state.complete}, game version ${state.gameVersion || 'unknown'})`);
}

/**
 * Load the terminal-to-terminal distance backup from disk, if present.
 * This is a static offline backup (see scan-terminal-distances.js) rather
 * than something the running server ever scans or refreshes itself -
 * terminal distances only change on major map reworks, so it's loaded
 * once at startup and used as-is. Missing file is not an error: Smart
 * Routes falls back to the M4 heuristic for any pair without real data.
 * @param {Object} cache - DataCache instance
 * @param {Object} [config] - Configuration object (for data_files.terminal_distances override)
 */
function loadTerminalDistances(cache, config) {
    const file = resolveDataFile(config, 'terminal_distances', DEFAULT_TERMINAL_DISTANCES_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('No terminal distance backup found, Smart Routes will use the time heuristic only');
        } else {
            logger.warn(`Could not read ${file}: ${error.message}`);
        }
        return;
    }

    let state;
    try {
        state = JSON.parse(raw);
    } catch (error) {
        logger.warn(`Terminal distance backup is corrupted, ignoring: ${error.message}`);
        return;
    }

    cache.setTerminalDistances(state.data || {});
    logger.info(`Loaded ${Object.keys(state.data || {}).length} terminal distances`);
}

/**
 * Persist the current confirmed max inventory scan state to disk.
 * Writes to a temp file and renames into place so a crash mid-write cannot
 * leave the target truncated (rename is atomic on POSIX).
 * Pretty-printed with 2-space indent so CI-committed diffs are reviewable.
 * @param {Object} cache - DataCache instance
 * @param {Object} [config] - Configuration object (for data_files.max_inventory override)
 */
function saveConfirmedMaxInventory(cache, config) {
    const file = resolveDataFile(config, 'max_inventory', DEFAULT_MAX_INVENTORY_FILE);
    const tempFile = `${file}.tmp`;
    try {
        fs.writeFileSync(tempFile, JSON.stringify(cache.exportMaxInventoryState(), null, 2));
        fs.renameSync(tempFile, file);
    } catch (error) {
        logger.warn(`Failed to save max inventory data: ${error.message}`);
        try { fs.unlinkSync(tempFile); } catch { /* nothing to clean up */ }
    }
}

/**
 * Process one batch of the commodity+terminal price history scan, replacing
 * estimated max SCU values with confirmed ones (the highest stock actually
 * observed in the last ~30 days). Remembers its position via the cache's
 * cursor and persists results to disk after every batch, so callers can call
 * this repeatedly (in a tight loop, or spread over time) and safely stop or
 * resume at any point without redoing work already done.
 * @param {Object} config - Configuration object
 * @param {Object} cache - DataCache instance
 * @returns {Promise<{complete: boolean, cursor: number, total: number, failures: number}>}
 *   Scan progress. `failures` counts pairs in this batch that couldn't be fetched
 *   (network error, HTTP 5xx after retries, etc); the standalone scanner
 *   aggregates these across the whole run so a transient UEX outage doesn't
 *   silently produce a mostly-empty file.
 */
async function refreshConfirmedMaxInventory(config, cache) {
    const cachedData = cache.getData();
    if (!cachedData) {
        // Data hasn't been loaded yet - not done, just not ready. Distinct from an
        // empty pair list below, which really does mean "nothing to scan."
        return { complete: false, cursor: cache.getMaxInventoryCursor(), total: 0, failures: 0 };
    }

    const pairs = [...new Set(cachedData.data.map(item => `${item.id_commodity}_${item.id_terminal}`))];

    if (cache.isMaxInventoryScanComplete() || pairs.length === 0) {
        return { complete: true, cursor: cache.getMaxInventoryCursor(), total: pairs.length, failures: 0 };
    }

    const cursor = cache.getMaxInventoryCursor();
    if (cursor >= pairs.length) {
        cache.setMaxInventoryScanComplete(true);
        saveConfirmedMaxInventory(cache, config);
        logger.info(`Confirmed max inventory scan complete (${pairs.length} pairs)`);
        return { complete: true, cursor, total: pairs.length, failures: 0 };
    }

    const batchKeys = pairs.slice(cursor, cursor + CONFIRMED_MAX_BATCH_SIZE);
    let failures = 0;

    await Promise.all(batchKeys.map(async key => {
        const [idCommodity, idTerminal] = key.split('_').map(Number);

        try {
            const resp = await uexApi.fetchStockHistory(idCommodity, idTerminal, config);
            if (!resp || !Array.isArray(resp.data) || resp.data.length === 0) return;

            const maxSell = Math.max(...resp.data.map(r => Number(r.scu_sell_stock) || 0));
            const maxBuy = Math.max(...resp.data.map(r => Number(r.scu_buy) || 0));

            if (maxSell > 0) cache.setConfirmedMax(key, 'sell', maxSell);
            if (maxBuy > 0) cache.setConfirmedMax(key, 'buy', maxBuy);
        } catch (error) {
            failures += 1;
            logger.debug(`Failed to fetch stock history for ${key}: ${error.message}`);
        }
    }));

    const newCursor = cursor + batchKeys.length;
    cache.setMaxInventoryCursor(newCursor);

    const complete = newCursor >= pairs.length;
    if (complete) {
        cache.setMaxInventoryScanComplete(true);
        logger.info(`Confirmed max inventory scan complete (${pairs.length} pairs)`);
    }

    saveConfirmedMaxInventory(cache, config);

    return { complete, cursor: newCursor, total: pairs.length, failures };
}

/**
 * Process solar systems data
 * @param {Object} rawData - Raw API response
 * @returns {Object} Processed systems data
 */
function processSolarSystems(rawData) {
    if (!rawData || !Array.isArray(rawData.data)) {
        logger.warn('Invalid solar systems data structure');
        return {};
    }

    return rawData.data.reduce((acc, item) => {
        if (item && item.id && item.name && item.code) {
            acc[item.id] = { name: item.name, code: item.code };
        }
        return acc;
    }, {});
}

/**
 * Process terminals data. Keyed by nickname, storing star-system id and the
 * planet the terminal belongs to (used for grouping in the touchportal
 * views). `planet_name` may be null for Lagrange stations etc.
 * @param {Object} rawData - Raw API response
 * @returns {Object} Map { [nickname]: { id_star_system, planet_name } }
 */
function processTerminals(rawData) {
    if (!rawData || !Array.isArray(rawData.data)) {
        logger.warn('Invalid terminals data structure');
        return {};
    }

    return rawData.data.reduce((acc, item) => {
        if (item && item.nickname && item.id_star_system) {
            acc[item.nickname] = {
                id_star_system: item.id_star_system,
                planet_name: item.planet_name || null,
                moon_name: item.moon_name || null,
                orbit_name: item.orbit_name || null,
                space_station_name: item.space_station_name || null,
                city_name: item.city_name || null,
                outpost_name: item.outpost_name || null,
                // Loading-mechanics flags for Smart Routes feasibility filtering
                // (docs/smart-routes-plan.md M3) - three orthogonal booleans,
                // see CLAUDE.md for why they're not collapsed into one flag.
                has_freight_elevator: !!item.has_freight_elevator,
                has_docking_port: !!item.has_docking_port,
                is_auto_load: !!item.is_auto_load
            };
        }
        return acc;
    }, {});
}

// SCU threshold above which manual box-by-box loading is considered
// impractical - see docs/smart-routes-plan.md M3 for the reasoning.
const NEEDS_AUTO_LOAD_SCU_THRESHOLD = 400;

/**
 * Filter UEX's ~280 vehicles down to cargo-relevant spaceships and derive
 * the feasibility flags Smart Routes needs (canLand, needsAutoLoad aren't
 * UEX fields - they're heuristics derived from pad_type and scu).
 * @param {Object} rawData - Raw API response
 * @returns {Array} Cargo-capable ships sorted by SCU ascending
 */
function processVehicles(rawData) {
    if (!rawData || !Array.isArray(rawData.data)) {
        logger.warn('Invalid vehicles data structure');
        return [];
    }

    return rawData.data
        .filter(v => v.is_spaceship && v.is_quantum_capable && (v.scu || 0) > 0)
        .map(v => ({
            id: v.id,
            slug: v.slug,
            name: v.name_full || v.name,
            manufacturer: decodeHtmlEntities(v.company_name) || 'Unknown',
            scu: Number(v.scu) || 0,
            pad_type: v.pad_type || '',
            container_sizes: v.container_sizes || '',
            canLand: ['XS', 'S', 'M', 'L'].includes(v.pad_type || ''),
            needsAutoLoad: (Number(v.scu) || 0) >= NEEDS_AUTO_LOAD_SCU_THRESHOLD
        }))
        .sort((a, b) => a.scu - b.scu);
}

/**
 * Initialize systems and terminals data
 * @param {Object} config - Configuration object
 * @param {Object} cache - DataCache instance
 * @returns {Promise<void>}
 */
async function initializeData(config, cache) {
    try {
        logger.info('Fetching initialization data...');

        // Systems/terminals are essential - the whole site depends on them, so
        // a failure here should propagate and abort startup. Vehicles are only
        // used by the (optional, gracefully-degrading) AI Trade Routes page,
        // so they're fetched separately and are never allowed to block the
        // rest of the site from loading (e.g. if a host's config.json predates
        // the "vehicles" endpoint being added, or the endpoint is briefly down).
        const [systemsResp, terminalsResp] = await Promise.all([
            uexApi.fetchSolarSystems(config),
            uexApi.fetchTerminals(config)
        ]);

        const systems = processSolarSystems(systemsResp);
        const terminals = processTerminals(terminalsResp);

        // mergedDict[terminal_nickname] = { name (system), code (system),
        //   planet_name, moon_name, orbit_name, space_station_name, city_name,
        //   outpost_name, has_freight_elevator, has_docking_port, is_auto_load }
        const mergedDict = [];
        Object.entries(terminals).forEach(([nickname, terminalMeta]) => {
            const system = systems[terminalMeta.id_star_system];
            if (system) {
                mergedDict[nickname] = { ...system, ...terminalMeta };
            }
        });

        cache.setInitData(mergedDict);
        logger.info('Initialization data processed successfully');

        try {
            const vehiclesResp = await uexApi.fetchVehicles(config);
            const vehicles = processVehicles(vehiclesResp);
            cache.setVehicles(vehicles);
            logger.info(`Loaded ${vehicles.length} vehicles from UEX`);
        } catch (vehiclesError) {
            logger.warn(`Failed to fetch vehicles, AI Trade Routes will show unconstrained routes: ${vehiclesError.message}`);
        }
    } catch (error) {
        logger.error('Failed to fetch init data:', error);
        throw error;
    }
}

/**
 * Get unique commodity names
 * @param {Object} cache - DataCache instance
 * @returns {Array<string>} Array of commodity names
 */
function getCommodities(cache) {
    cache.clearProfit();
    const data = cache.getData();
    return [...new Set(data.data.map(item => item.commodity_name))];
}

/**
 * Generate sell price data organized by commodity
 * @param {Object} cache - DataCache instance
 * @returns {Object} Commodities with sell data
 */
function generateSellData(cache) {
    const commodities = {};
    const cachedData = cache.getData();
    const cachedInitData = cache.getInitData();

    cachedData.data.forEach(item => {
        const { commodity_name, container_sizes, terminal_name, price_sell, price_sell_avg, scu_sell_stock, scu_sell_stock_avg, status_sell, status_buy, date_modified, id_commodity, id_terminal } = item;

        let system = cachedInitData?.[terminal_name]?.code ?? '(?) ';
        if (system !== '(?) ') system = '(' + system + ') ';

        if (price_sell === 0) return;

        if (!commodities[commodity_name]) {
            commodities[commodity_name] = [];
        }

        const confirmedMax = cache.getConfirmedMax(`${id_commodity}_${id_terminal}`, 'sell');

        commodities[commodity_name].push({
            terminal_name: system + terminal_name,
            container_sizes,
            price_sell: price_sell > 0 ? price_sell : null,
            price_sell_avg: price_sell_avg > 0 ? price_sell_avg : null,
            scu_sell: scu_sell_stock > 0 ? scu_sell_stock : null,
            scu_sell_avg: scu_sell_stock_avg > 0 ? scu_sell_stock_avg : null,
            scu_sell_max: confirmedMax ?? estimateMaxInventory(scu_sell_stock, status_sell),
            scu_sell_max_is_estimate: confirmedMax === undefined,
            status_sell,
            date_modified,
        });
    });

    return commodities;
}

/**
 * Generate buy price data organized by commodity
 * @param {Object} cache - DataCache instance
 * @returns {Object} Commodities with buy data
 */
function generateBuyData(cache) {
    const commodities = {};
    const cachedData = cache.getData();
    const cachedInitData = cache.getInitData();

    cachedData.data.forEach(item => {
        const { commodity_name, container_sizes, terminal_name, price_buy, price_buy_avg, scu_buy, scu_buy_avg, status_buy, status_sell, date_modified, id_commodity, id_terminal } = item;

        let system = cachedInitData?.[terminal_name]?.code ?? '(?) ';
        if (system !== '(?) ') system = '(' + system + ') ';

        if (price_buy === 0) return;

        if (!commodities[commodity_name]) {
            commodities[commodity_name] = [];
        }

        const confirmedMax = cache.getConfirmedMax(`${id_commodity}_${id_terminal}`, 'buy');

        commodities[commodity_name].push({
            terminal_name: system + terminal_name,
            container_sizes,
            price_buy: price_buy > 0 ? price_buy : null,
            price_buy_avg: price_buy_avg > 0 ? price_buy_avg : null,
            scu_buy: scu_buy > 0 ? scu_buy : null,
            scu_buy_avg: scu_buy_avg > 0 ? scu_buy_avg : null,
            scu_buy_max: confirmedMax ?? estimateMaxInventory(scu_buy, status_buy),
            scu_buy_max_is_estimate: confirmedMax === undefined,
            status_buy,
            date_modified,
        });
    });

    return commodities;
}

/**
 * Aggregate market depth for all commodities at once.
 * Used by the TouchPortal market depth page.
 * @param {Object} cache - DataCache instance
 * @returns {Array} Sorted by marketPotential descending, filtered to margin > 0
 */
function generateMarketDepth(cache, systemFilter) {
    const data = cache.getData();
    if (!data) return [];

    const { estimateMaxInventory } = require('../utils/formatters.js');
    const initData = cache.getInitData();
    const byComm = {};

    data.data.forEach(item => {
        if (systemFilter) {
            const sys = initData?.[item.terminal_name]?.name;
            if (sys !== systemFilter) return;
        }

        const name = item.commodity_name;
        if (!byComm[name]) {
            byComm[name] = { commodity: name, buyCurrent: 0, buyMax: 0, buyTerminals: 0, sellCurrent: 0, sellMax: 0, sellTerminals: 0, bestBuyPrice: Infinity, bestSellPrice: 0 };
        }
        const c = byComm[name];

        if (item.price_buy > 0 && item.scu_buy > 0) {
            const confirmed = cache.getConfirmedMax(`${item.id_commodity}_${item.id_terminal}`, 'buy');
            c.buyCurrent += item.scu_buy;
            c.buyMax += confirmed ?? estimateMaxInventory(item.scu_buy, item.status_buy);
            c.buyTerminals++;
            if (item.price_buy < c.bestBuyPrice) c.bestBuyPrice = item.price_buy;
        }

        if (item.price_sell > 0 && item.scu_sell_stock > 0) {
            const confirmed = cache.getConfirmedMax(`${item.id_commodity}_${item.id_terminal}`, 'sell');
            c.sellCurrent += item.scu_sell_stock;
            c.sellMax += confirmed ?? estimateMaxInventory(item.scu_sell_stock, item.status_sell);
            c.sellTerminals++;
            if (item.price_sell > c.bestSellPrice) c.bestSellPrice = item.price_sell;
        }
    });

    return Object.values(byComm)
        .map(c => {
            const bestBuy = c.bestBuyPrice === Infinity ? 0 : c.bestBuyPrice;
            const margin = c.bestSellPrice - bestBuy;
            const tradeableCurrent = Math.min(c.buyCurrent, c.sellCurrent);
            const tradeableMax = Math.min(c.buyMax, c.sellMax);
            const potentialCurrent = margin > 0 && tradeableCurrent > 0 ? tradeableCurrent * margin : 0;
            const potentialMax = margin > 0 && tradeableMax > 0 ? tradeableMax * margin : 0;
            return { ...c, bestBuy, bestSellPrice: c.bestSellPrice, margin, tradeableCurrent, tradeableMax, potentialCurrent, potentialMax };
        })
        .filter(c => c.margin > 0 && c.potentialCurrent > 0)
        .sort((a, b) => b.potentialCurrent - a.potentialCurrent);
}

function getSystemNames(cache) {
    const initData = cache.getInitData();
    if (!initData) return [];
    return [...new Set(Object.values(initData).map(v => v.name).filter(Boolean))].sort();
}

module.exports = {
    refreshData,
    refreshConfirmedMaxInventory,
    loadConfirmedMaxInventory,
    saveConfirmedMaxInventory,
    loadTerminalDistances,
    fetchLiveGameVersion,
    initializeData,
    getCommodities,
    generateSellData,
    generateBuyData,
    generateMarketDepth,
    getSystemNames,
    processVehicles
};
