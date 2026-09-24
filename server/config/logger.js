const winston = require('winston');
require('winston-daily-rotate-file');

const { combine, timestamp, printf, errors, json } = winston.format;

// Format to redact sensitive data from logs
const redact = winston.format((info) => {
    const sensitiveKeys = ['password', 'token', 'secret', 'POSTGRES_PASSWORD', 'DATABASE_URL'];
    
    const sanitize = (obj) => {
        if (typeof obj !== 'object' || obj === null) return;
        for (const key in obj) {
            if (sensitiveKeys.includes(key) || key.toLowerCase().includes('password')) {
                obj[key] = '[REDACTED]';
            } else if (typeof obj[key] === 'object') {
                sanitize(obj[key]);
            }
        }
    };

    // Redact password from PostgreSQL URIs inside string messages
    if (info.message && typeof info.message === 'string') {
        info.message = info.message.replace(/:(.+?)@/, ':[REDACTED]@');
    }

    sanitize(info);
    return info;
});

const fileTransport = new winston.transports.DailyRotateFile({
    filename: 'logs/server-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
});

const consoleTransport = new winston.transports.Console({
    format: combine(
        winston.format.colorize(),
        printf(({ level, message, timestamp, stack }) => {
            return `[${timestamp}] ${level}: ${stack || message}`;
        })
    )
});

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        errors({ stack: true }), // Capture stack traces for errors
        timestamp(),
        redact(),
        json() // Structured JSON format for log files
    ),
    transports: [
        consoleTransport,
        fileTransport
    ]
});

module.exports = logger;
