const winston = require('winston');
const fs = require('fs');

/**
 * Initialize Winston logger
 * @param {Object} config - Configuration object (optional)
 * @returns {winston.Logger} Configured logger instance
 */
function createLogger(config) {
    const logConfig = config?.logging || {
        level: 'info',
        file: 'trading.log',
        console: true
    };

    const transports = [];

    // Console transport
    if (logConfig.console) {
        transports.push(new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `${timestamp} [${level}]: ${message}`;
                })
            )
        }));
    }

    // File transport
    if (logConfig.file) {
        transports.push(new winston.transports.File({
            filename: logConfig.file,
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `${timestamp} [${level}]: ${message}`;
                })
            ),
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }));
    }

    return winston.createLogger({
        level: logConfig.level || 'info',
        transports
    });
}

// Try to load config, fallback to defaults if not available
let logger;
try {
    const configData = fs.readFileSync('./config.json', 'utf8');
    const config = JSON.parse(configData);
    logger = createLogger(config);
} catch (error) {
    // Fallback to console-only logging if config not available
    logger = createLogger({ logging: { console: true, level: 'info' } });
}

module.exports = logger;
