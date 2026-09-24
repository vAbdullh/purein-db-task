const path = require('path');
const fs = require('fs');
const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { hashFile } = require('../utils/hash');
const { controllerTimeToUtc } = require('../utils/time');
const { isAmountValid, isSalePacketValid, isProbePacketValid } = require('../utils/validate');

const MESSAGES_PATH = process.env.MESSAGES_PATH || path.resolve(__dirname, '../../messages.json');
const STATIONS_PATH = process.env.STATIONS_PATH || path.resolve(__dirname, '../../stations.json');

/**
 * Loads stations.json and messages.json into the database in a single transaction.
 * Idempotent: re-running with the same file produces no new rows.
 */
async function runLoader() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('Data Loader starting up...');
    logger.info(`Reading stations from  → ${STATIONS_PATH}`);
    logger.info(`Reading deliveries from → ${MESSAGES_PATH}`);

    // ── 1. Read files ────────────────────────────────────────────────────────
    const sourceHash = hashFile(MESSAGES_PATH);
    logger.info(`File fingerprint (SHA-256): ${sourceHash}`);

    const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8')).stations;
    const messages = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));

    // Build a fast lookup: pts_id → station row
    const stationMap = new Map(stations.map((s) => [s.pts_id, s]));

    logger.info(`Found ${stations.length} registered station(s) and ${messages.length} incoming deliveries.`);
    logger.info('Opening database transaction — all or nothing...');

    // ── 2. Single database transaction ───────────────────────────────────────
    await prisma.$transaction(async (tx) => {

        // 2a. Upsert stations (idempotent, safe to re-run)
        logger.info(`Loading ${stations.length} station(s) into the database...`);
        for (const s of stations) {
            await tx.station.upsert({
                where: { station_code: s.station_code },
                update: {
                    station_name: s.station_name,
                    pts_id: s.pts_id,
                    utc_offset_minutes: s.utc_offset_minutes,
                },
                create: {
                    station_code: s.station_code,
                    station_name: s.station_name,
                    pts_id: s.pts_id,
                    utc_offset_minutes: s.utc_offset_minutes,
                },
            });
            logger.info(`  ✔ Station "${s.station_name}" (code: ${s.station_code}, UTC offset: ${s.utc_offset_minutes} min)`);
        }
        logger.info('All stations are up to date.');

        // Counters for the final summary
        const counters = { sales: 0, probes: 0, skipped: 0, issues: 0 };

        // Keep a set of (pts_id, pump, transaction_number) for within-run dedup
        const seenSales = new Set();

        logger.info(`Processing ${messages.length} deliveries in file order...`);

        // 2b. Process each delivery in file order
        for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
            const msg = messages[msgIdx];
            const sourcePosition = msgIdx + 1; // 1-based to satisfy CHECK (source_position > 0)
            const ptsId = msg.PtsId;

            // ── Delivery (idempotent via unique constraint) ──────────────────
            let delivery;
            const existingDelivery = await tx.delivery.findUnique({
                where: { source_hash_source_position: { source_hash: sourceHash, source_position: sourcePosition } },
            });

            if (existingDelivery) {
                // Already loaded from this exact file — skip entirely
                delivery = existingDelivery;
                logger.debug(`Delivery #${sourcePosition} was already loaded in a previous run — skipping.`);
                counters.skipped++;
                continue;
            }

            delivery = await tx.delivery.create({
                data: {
                    source_hash: sourceHash,
                    source_position: sourcePosition,
                    pts_id: ptsId,
                    protocol: msg.Protocol || 'jsonPTS',
                    raw_message: msg,
                },
            });

            const station = stationMap.get(ptsId);
            const packets = Array.isArray(msg.Packets) ? msg.Packets : [];

            // ── Packets ──────────────────────────────────────────────────────
            for (let pktIdx = 0; pktIdx < packets.length; pktIdx++) {
                const rawPkt = packets[pktIdx];
                const packetPosition = pktIdx + 1; // 1-based
                const data = rawPkt.Data || {};

                const packet = await tx.packet.create({
                    data: {
                        delivery_id: delivery.id,
                        packet_position: packetPosition,
                        reported_packet_id: rawPkt.Id ?? null,
                        packet_type: rawPkt.Type || 'UNKNOWN',
                        raw_packet: rawPkt,
                    },
                });

                // ── Unknown controller ───────────────────────────────────────
                if (!station) {
                    await tx.data_issue.create({
                        data: {
                            packet_id: packet.id,
                            issue_code: 'UNKNOWN_CONTROLLER',
                            details: `Controller "${ptsId}" is not registered in stations.json. Cannot attribute this packet to any station.`,
                        },
                    });
                    logger.warn(`  ⚠ Delivery #${sourcePosition}: controller "${ptsId}" is not registered — flagged as UNKNOWN_CONTROLLER.`);
                    counters.issues++;
                    continue;
                }

                const packetType = rawPkt.Type;

                // ── UploadPumpTransaction ────────────────────────────────────
                if (packetType === 'UploadPumpTransaction') {
                    if (!isSalePacketValid(data)) {
                        await tx.data_issue.create({
                            data: {
                                packet_id: packet.id,
                                issue_code: 'INVALID_PACKET',
                                details: `Sale packet at delivery #${sourcePosition}, position #${packetPosition} is missing one or more required fields. Raw data: ${JSON.stringify(data)}`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}, packet #${packetPosition}: sale packet has missing fields — flagged as INVALID_PACKET.`);
                        counters.issues++;
                        continue;
                    }

                    const volume = parseFloat(data.Volume);
                    const price = parseFloat(data.Price);
                    const amount = parseFloat(data.Amount);
                    const transactionNumber = String(data.Transaction);
                    const pump = String(data.Pump);
                    const nozzle = String(data.Nozzle);
                    const saleKey = `${ptsId}::${pump}::${transactionNumber}`;

                    const controllerTime = data.DateTime;
                    const eventTimeUtc = controllerTimeToUtc(controllerTime, station.utc_offset_minutes);

                    // Flag amount mismatch (keep reported values as-is)
                    if (!isAmountValid(volume, price, amount)) {
                        await tx.data_issue.upsert({
                            where: { packet_id_issue_code: { packet_id: packet.id, issue_code: 'AMOUNT_MISMATCH' } },
                            update: {},
                            create: {
                                packet_id: packet.id,
                                issue_code: 'AMOUNT_MISMATCH',
                                details: `Transaction #${transactionNumber} on pump ${pump}: reported amount ${amount} SAR does not match ${volume} L × ${price} SAR/L = ${(volume * price).toFixed(2)} SAR. Stored as-is.`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} has an amount mismatch (${amount} ≠ ${(volume * price).toFixed(2)}) — flagged as AMOUNT_MISMATCH.`);
                        counters.issues++;
                    }

                    // Duplicate within this run (same key already processed)
                    if (seenSales.has(saleKey)) {
                        await tx.data_issue.create({
                            data: {
                                packet_id: packet.id,
                                issue_code: 'DUPLICATE_SALE',
                                details: `Transaction #${transactionNumber} on pump ${pump} for station "${ptsId}" appeared more than once in this file. Only the first occurrence was recorded.`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} is a duplicate within this file — flagged as DUPLICATE_SALE.`);
                        counters.issues++;
                        continue;
                    }

                    // Check for a conflicting sale already in the DB (same key, different values)
                    const existingSale = await tx.sale.findUnique({
                        where: { pts_id_pump_transaction_number: { pts_id: ptsId, pump, transaction_number: transactionNumber } },
                    });

                    if (existingSale) {
                        const isDifferent =
                            Number(existingSale.volume_litres) !== volume ||
                            Number(existingSale.price_sar_per_litre) !== price ||
                            Number(existingSale.amount_sar) !== amount;

                        if (isDifferent) {
                            await tx.data_issue.create({
                                data: {
                                    packet_id: packet.id,
                                    issue_code: 'CONFLICTING_SALE',
                                    details: `Transaction #${transactionNumber} on pump ${pump} already exists in the database with different values. Stored: vol=${existingSale.volume_litres} L, price=${existingSale.price_sar_per_litre} SAR/L, amount=${existingSale.amount_sar} SAR. Incoming: vol=${volume} L, price=${price} SAR/L, amount=${amount} SAR. Incoming values were NOT applied.`,
                                },
                            });
                            logger.warn(`  ⚠ Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} conflicts with an existing record in the database — flagged as CONFLICTING_SALE.`);
                            counters.issues++;
                        } else {
                            logger.debug(`  — Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} is an exact duplicate of a database record — safely skipped.`);
                        }
                        seenSales.add(saleKey);
                        continue;
                    }

                    // Insert new sale
                    await tx.sale.create({
                        data: {
                            source_packet_id: packet.id,
                            pts_id: ptsId,
                            pump,
                            nozzle,
                            transaction_number: transactionNumber,
                            fuel_grade_name: data.FuelGradeName,
                            controller_time: new Date(controllerTime),
                            event_time_utc: eventTimeUtc,
                            volume_litres: volume,
                            price_sar_per_litre: price,
                            amount_sar: amount,
                        },
                    });

                    logger.info(`  ✔ Recorded sale — Tx #${transactionNumber} | Pump ${pump} | ${data.FuelGradeName} | ${volume} L | ${amount} SAR | UTC: ${eventTimeUtc.toISOString()}`);
                    seenSales.add(saleKey);
                    counters.sales++;

                // ── ProbeMeasurements ────────────────────────────────────────
                } else if (packetType === 'ProbeMeasurements') {
                    if (!isProbePacketValid(data)) {
                        await tx.data_issue.create({
                            data: {
                                packet_id: packet.id,
                                issue_code: 'INVALID_PACKET',
                                details: `Probe packet at delivery #${sourcePosition}, position #${packetPosition} is missing one or more required fields. Raw data: ${JSON.stringify(data)}`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}, packet #${packetPosition}: probe packet has missing fields — flagged as INVALID_PACKET.`);
                        counters.issues++;
                        continue;
                    }

                    const controllerTime = data.DateTime;
                    const eventTimeUtc = controllerTimeToUtc(controllerTime, station.utc_offset_minutes);

                    await tx.probe_reading.create({
                        data: {
                            source_packet_id: packet.id,
                            pts_id: ptsId,
                            probe: String(data.Probe),
                            controller_time: new Date(controllerTime),
                            event_time_utc: eventTimeUtc,
                            product_volume_litres: parseFloat(data.ProductVolume),
                        },
                    });

                    logger.info(`  ✔ Recorded tank reading — Probe ${data.Probe} | ${parseFloat(data.ProductVolume).toLocaleString()} L in tank | UTC: ${eventTimeUtc.toISOString()}`);
                    counters.probes++;

                } else {
                    // Packet type we don't recognise
                    await tx.data_issue.create({
                        data: {
                            packet_id: packet.id,
                            issue_code: 'INVALID_PACKET',
                            details: `Packet at delivery #${sourcePosition}, position #${packetPosition} has an unrecognised type: "${packetType}".`,
                        },
                    });
                    logger.warn(`  ⚠ Delivery #${sourcePosition}, packet #${packetPosition}: unrecognised packet type "${packetType}" — flagged as INVALID_PACKET.`);
                    counters.issues++;
                }
            }
        }

        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.info('Load complete — committing transaction...');
        logger.info(`  Sales recorded    : ${counters.sales}`);
        logger.info(`  Tank readings     : ${counters.probes}`);
        logger.info(`  Deliveries skipped: ${counters.skipped} (already in DB)`);
        logger.info(`  Issues flagged    : ${counters.issues}`);
        logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    }, {
        timeout: 60_000, // allow up to 60 s for the full load
    });

    logger.info('Transaction committed successfully. The database is ready.');
}

module.exports = { runLoader };

