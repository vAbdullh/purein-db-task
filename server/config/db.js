const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MAX_DELAY_MS = 5000;

function getDelay(attempt) {
    return Math.min(1000 * Math.pow(1.5, attempt), MAX_DELAY_MS);
}

const logger = require('./logger');

async function connectDB() {
    let attempt = 0;
    while (true) {
        try {
            logger.info('Initializing connection to the PostgreSQL database...');
            await prisma.$connect();
            logger.info('Connection successful. The database is now ready.');
            
            // Periodically ping to detect lost connections (since Prisma doesn't have an 'error' event emitter)
            setInterval(async () => {
                try {
                    await prisma.$queryRaw`SELECT 1`;
                } catch (err) {
                    logger.error('Critical Error: Database connection was unexpectedly lost.', { error: err, stack: err.stack });
                    // Force a restart of the app or implement specific reconnect logic if preferred
                    process.exit(1); 
                }
            }, 10000);

            break; // connection successful
        } catch (err) {
            attempt++;
            const delay = getDelay(attempt);
            logger.error(`Attempt ${attempt} failed to connect to database. Waiting ${delay}ms before next attempt...`, { error: err, stack: err.stack });
            await new Promise(res => setTimeout(res, delay));
            logger.info('Retrying connection to the database now...');
        }
    }
}

module.exports = { prisma, connectDB };
