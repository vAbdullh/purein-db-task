require('dotenv').config({ path: '../.env' });
const express = require('express');
const { prisma, connectDB } = require('./config/db');
const logger = require('./config/logger');

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

app.get('/', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        logger.info('Health check passed: Database connected');
        res.send('Node.js Service: Connected to PostgreSQL via Prisma');
    } catch (err) {
        logger.error('Health check failed: Database connection is down', { error: err, stack: err.stack });
        res.status(503).send('Node.js Service: Database connection is down');
    }
});

app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
    connectDB();
});
