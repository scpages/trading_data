/**
 * Shared Configuration Loader
 * Loads config.json, then deep-merges config.local.json on top if present.
 * config.local.json is gitignored and used for local secrets (influx creds, etc).
 */

const fs = require('fs');
const path = require('path');

function deepMerge(base, override) {
    const out = Object.assign({}, base);
    for (const key of Object.keys(override)) {
        if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key]) &&
            base[key]    && typeof base[key]    === 'object' && !Array.isArray(base[key])) {
            out[key] = deepMerge(base[key], override[key]);
        } else {
            out[key] = override[key];
        }
    }
    return out;
}

function loadConfig(filename = './config.json') {
    let base;
    try {
        base = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        console.error(`ERROR: Could not load config file (${filename}):`, error.message);
        process.exit(1);
    }

    const localFile = path.join(path.dirname(filename), 'config.local.json');
    try {
        const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
        base = deepMerge(base, local);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.warn(`Warning: Could not load ${localFile}: ${e.message}`);
        }
    }

    return base;
}

module.exports = { loadConfig };
