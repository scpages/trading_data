/**
 * InfluxDB integration — max inventory enrichment and restock analytics
 *
 * Two functions are exported:
 *   enrichMaxInventory(cache, config) — seeds confirmedMaxInventory from
 *     historical MAX(scu) values; run once after the live price data loads.
 *   getRestockStats(config) — returns per-commodity restock timing derived
 *     from the SCU time series (last restock, avg cycle, depletion rate).
 */

const https = require('https');
const http  = require('http');
const url   = require('url');
const logger = require('../logger.js');

function buildAuth(config) {
    const c = config?.influx;
    return c ? { user: c.user, pass: c.password } : null;
}

function influxQuery(config, q) {
    return new Promise((resolve, reject) => {
        const c = config?.influx;
        if (!c) return reject(new Error('No influx config'));

        const parsed = url.parse(c.url);
        const qs = `db=${encodeURIComponent(c.db)}&q=${encodeURIComponent(q)}`;
        const options = {
            hostname: parsed.hostname,
            port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path:     '/query?' + qs,
            method:   'GET',
            auth:     `${c.user}:${c.password}`,
        };

        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, res => {
            let body = '';
            res.on('data', d => { body += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`InfluxDB parse error: ${body.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('InfluxDB timeout')); });
        req.end();
    });
}

/**
 * Seed confirmedMaxInventory from InfluxDB historical MAX(scu).
 * Matches by terminal+commodity name using the live price data's ID fields.
 * Only updates a key if the InfluxDB value is higher than what's already stored.
 */
async function enrichMaxInventory(cache, config) {
    if (!config?.influx) return;

    const priceData = cache.getData();
    if (!priceData?.data) {
        logger.warn('[influx] Price data not loaded yet, skipping max inventory enrichment');
        return;
    }

    // Build name→ID lookup maps from live price data (covers all known terminals/commodities)
    const terminalIdByName = {};
    const commodityIdByName = {};
    for (const item of priceData.data) {
        if (item.terminal_name && item.id_terminal) terminalIdByName[item.terminal_name] = item.id_terminal;
        if (item.commodity_name && item.id_commodity) commodityIdByName[item.commodity_name] = item.id_commodity;
    }

    let res;
    try {
        res = await influxQuery(config, 'SELECT MAX(scu) FROM Market WHERE scu > 0 GROUP BY terminal, commodity, trade_type');
    } catch (e) {
        logger.warn(`[influx] enrichMaxInventory query failed: ${e.message || e}`);
        return;
    }

    const series = res?.results?.[0]?.series || [];
    let updated = 0;

    for (const s of series) {
        const { terminal, commodity, trade_type } = s.tags;
        const maxScu = s.values?.[0]?.[1];
        if (!maxScu || maxScu <= 0) continue;

        const idTerminal  = terminalIdByName[terminal];
        const idCommodity = commodityIdByName[commodity];
        if (!idTerminal || !idCommodity) continue;

        const side = trade_type === 'buy' ? 'buy' : 'sell';
        const key  = `${idCommodity}_${idTerminal}`;

        const existing = cache.getConfirmedMax(key, side);
        if (!existing || maxScu > existing) {
            cache.setConfirmedMax(key, side, maxScu);
            updated++;
        }
    }

    logger.info(`[influx] Max inventory enrichment: updated ${updated} pairs from ${series.length} InfluxDB series`);
}

/**
 * Compute per-commodity restock statistics from the InfluxDB SCU time series.
 * Returns a map: { commodity: { lastRestockH, avgCycleH, depletionRateSCUH, hoursToEmpty } }
 * All times in hours. lastRestockH = hours since last restock (null if no restock found).
 */
async function getRestockStats(config) {
    if (!config?.influx) return {};

    let res;
    try {
        res = await influxQuery(config,
            "SELECT scu FROM Market WHERE trade_type='buy' AND scu >= 0 AND time > now()-90d ORDER BY time ASC"
        );
    } catch (e) {
        logger.warn(`[influx] getRestockStats query failed: ${e.message}`);
        return {};
    }

    const series = res?.results?.[0]?.series;
    if (!series) return {};

    // Group raw points by commodity+terminal so we can detect events per-pair
    const byPair = {};
    for (const point of series[0].values) {
        const [ts, scu, , commodity, , terminal] = point;
        // InfluxDB returns GROUP BY columns inline — but here we queried without GROUP BY
        // so all columns are: time, scu (fields only, tags not inline without SHOW)
        // We need to re-query with GROUP BY to get tags properly.
    }

    // Re-query properly with GROUP BY
    let res2;
    try {
        res2 = await influxQuery(config,
            "SELECT MAX(scu) as max_scu FROM Market WHERE trade_type='buy' AND time > now()-90d GROUP BY commodity"
        );
    } catch (e) {
        logger.warn(`[influx] getRestockStats max query failed: ${e.message}`);
        return {};
    }

    // Build per-commodity max SCU map
    const maxByCommodity = {};
    for (const s of (res2?.results?.[0]?.series || [])) {
        const maxScu = s.values?.[0]?.[1];
        if (maxScu > 0) maxByCommodity[s.tags.commodity] = maxScu;
    }

    // Query SCU time series per commodity (aggregated across terminals with SUM)
    // We use MEAN per 6h bucket to smooth noise, then detect restock events
    let res3;
    try {
        res3 = await influxQuery(config,
            "SELECT SUM(scu) as total_scu FROM Market WHERE trade_type='buy' AND time > now()-90d GROUP BY time(6h), commodity fill(previous)"
        );
    } catch (e) {
        logger.warn(`[influx] getRestockStats timeseries query failed: ${e.message}`);
        return {};
    }

    const stats = {};
    const now = Date.now();

    for (const s of (res3?.results?.[0]?.series || [])) {
        const commodity = s.tags.commodity;
        const vals = (s.values || []).filter(v => v[1] !== null);
        if (vals.length < 4) continue;

        // Detect restock events: SUM increases by >5% of commodity max * terminal count
        // Use a relative threshold: increase > 15% of the running max seen
        let runningMax = 0;
        const restocks = [];
        const depletions = [];
        let prev = null;

        for (const [ts, scu] of vals) {
            if (scu > runningMax) runningMax = scu;
            if (prev !== null && runningMax > 0) {
                const delta = scu - prev.scu;
                const threshold = runningMax * 0.10;
                if (delta > threshold) {
                    restocks.push(new Date(ts).getTime());
                } else if (delta < -threshold) {
                    depletions.push({ t: new Date(ts).getTime(), delta: Math.abs(delta), hrs: 6 });
                }
            }
            prev = { ts, scu };
        }

        if (restocks.length < 1) continue;

        const lastRestockMs = restocks[restocks.length - 1];
        const lastRestockH  = (now - lastRestockMs) / 3600000;

        let avgCycleH = null;
        if (restocks.length >= 2) {
            const intervals = [];
            for (let i = 1; i < restocks.length; i++) {
                intervals.push((restocks[i] - restocks[i-1]) / 3600000);
            }
            avgCycleH = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        }

        let depletionRateSCUH = null;
        if (depletions.length > 0) {
            const rates = depletions.map(d => d.delta / d.hrs);
            depletionRateSCUH = rates.reduce((a, b) => a + b, 0) / rates.length;
        }

        const maxScu = maxByCommodity[commodity];
        const hoursToEmpty = (maxScu && depletionRateSCUH) ? maxScu / depletionRateSCUH : null;

        stats[commodity] = {
            lastRestockH:       Math.round(lastRestockH * 10) / 10,
            avgCycleH:          avgCycleH  ? Math.round(avgCycleH)  : null,
            depletionRateSCUH:  depletionRateSCUH ? Math.round(depletionRateSCUH) : null,
            hoursToEmpty:       hoursToEmpty ? Math.round(hoursToEmpty * 10) / 10 : null,
        };
    }

    logger.info(`[influx] Restock stats computed for ${Object.keys(stats).length} commodities`);
    return stats;
}

module.exports = { enrichMaxInventory, getRestockStats };
