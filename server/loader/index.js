const path = require('path');
const fs = require('fs');
const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { hashFile } = require('../utils/hash');
const { controllerTimeToUtc } = require('../utils/time');
const { isAmountValid, validateSalePacket, validateProbePacket, AMOUNT_TOLERANCE_SAR } = require('../utils/validate');

const MESSAGES_PATH = process.env.MESSAGES_PATH || path.resolve(__dirname, '../../messages.json');
const STATIONS_PATH = process.env.STATIONS_PATH || path.resolve(__dirname, '../../stations.json');

// ── File parsing helpers ─────────────────────────────────────────────────────

function readStations() {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`Cannot parse stations file at "${STATIONS_PATH}": ${err.message}`);
    }
    if (!Array.isArray(raw?.stations)) {
        throw new Error(`stations.json must have a top-level "stations" array. Got: ${JSON.stringify(raw).slice(0, 80)}`);
    }
    return raw.stations;
}

function readMessages() {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
    } catch (err) {
        throw new Error(`Cannot parse messages file at "${MESSAGES_PATH}": ${err.message}`);
    }
    if (!Array.isArray(raw)) {
        throw new Error(`messages.json must be a JSON array at the top level.`);
    }
    return raw;
}

// ── Decimal comparison helper ────────────────────────────────────────────────
// Prisma returns Decimal objects for NUMERIC columns. Compare as fixed-precision
// strings to avoid floating-point drift (e.g. 47.320 stored vs 47.32 parsed).
function decimalsDiffer(decimalObj, jsNumber, decimalPlaces) {
    return parseFloat(decimalObj.toString()).toFixed(decimalPlaces) !==
           parseFloat(jsNumber).toFixed(decimalPlaces);
}

// ── Main loader ──────────────────────────────────────────────────────────────

/**
 * Loads stations.json and messages.json into the database in a single transaction.
 * Idempotent: re-running with the same file produces no new rows.
 */
async function runLoader() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('Data Loader starting up...');
    logger.info(`Reading stations from  → ${STATIONS_PATH}`);
    logger.info(`Reading deliveries from → ${MESSAGES_PATH}`);
    logger.info(`Amount mismatch tolerance: ${AMOUNT_TOLERANCE_SAR} SAR`);

    // ── 1. Read and validate files (before opening any DB connection) ─────────
    const sourceHash = hashFile(MESSAGES_PATH);
    logger.info(`File fingerprint (SHA-256): ${sourceHash}`);

    const stations = readStations();
    const messages = readMessages();

    const stationMap = new Map(stations.map((s) => [s.pts_id, s]));

    logger.info(`Found ${stations.length} registered station(s) and ${messages.length} incoming deliveries.`);
    logger.info('Opening database transaction — all or nothing...');

    // ── 2. Single database transaction ───────────────────────────────────────
    await prisma.$transaction(async (tx) => {

        // ── 2a. Upsert stations ──────────────────────────────────────────────
        logger.info(`Loading ${stations.length} station(s) into the database...`);
        for (const s of stations) {
            await tx.station.upsert({
                where:  { station_code: s.station_code },
                update: { station_name: s.station_name, pts_id: s.pts_id, utc_offset_minutes: s.utc_offset_minutes },
                create: { station_code: s.station_code, station_name: s.station_name, pts_id: s.pts_id, utc_offset_minutes: s.utc_offset_minutes },
            });
            logger.info(`  ✔ Station "${s.station_name}" (code: ${s.station_code}, UTC offset: ${s.utc_offset_minutes} min)`);
        }
        logger.info('All stations are up to date.');

        const counters = { sales: 0, probes: 0, skipped: 0, issues: 0 };

        // Within-run dedup sets — keyed on pts_id::pump::transaction_number and pts_id::probe::controller_time
        const seenSales  = new Set();
        const seenProbes = new Set();

        logger.info(`Processing ${messages.length} deliveries in file order...`);

        // ── 2b. Process each delivery ────────────────────────────────────────
        for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
            const msg            = messages[msgIdx];
            const sourcePosition = msgIdx + 1;
            const ptsId          = msg.PtsId;

            // Guard: missing PtsId would crash with a DB NOT NULL error
            if (!ptsId) {
                logger.warn(`  ⚠ Delivery #${sourcePosition} has no PtsId field — skipping entire delivery.`);
                counters.issues++;
                continue;
            }

            // Idempotency: skip deliveries already loaded from this exact file
            const existingDelivery = await tx.delivery.findUnique({
                where: { source_hash_source_position: { source_hash: sourceHash, source_position: sourcePosition } },
            });
            if (existingDelivery) {
                logger.debug(`Delivery #${sourcePosition} was already loaded in a previous run — skipping.`);
                counters.skipped++;
                continue;
            }

            const delivery = await tx.delivery.create({
                data: {
                    source_hash:     sourceHash,
                    source_position: sourcePosition,
                    pts_id:          ptsId,
                    protocol:        msg.Protocol || 'jsonPTS',
                    raw_message:     msg,
                },
            });

            const station = stationMap.get(ptsId);
            const packets = Array.isArray(msg.Packets) ? msg.Packets : [];

            // ── 2c. Process each packet ──────────────────────────────────────
            for (let pktIdx = 0; pktIdx < packets.length; pktIdx++) {
                const rawPkt        = packets[pktIdx];
                const packetPosition = pktIdx + 1;
                const data          = rawPkt.Data || {};
                // Read type once with fallback so all downstream branches are consistent
                const packetType    = rawPkt.Type || 'UNKNOWN';

                const packet = await tx.packet.create({
                    data: {
                        delivery_id:        delivery.id,
                        packet_position:    packetPosition,
                        reported_packet_id: rawPkt.Id ?? null,
                        packet_type:        packetType,
                        raw_packet:         rawPkt,
                    },
                });

                // ── Unknown controller ───────────────────────────────────────
                if (!station) {
                    const rawTimestamp = data.DateTime ?? '(no timestamp)';
                    await tx.data_issue.create({
                        data: {
                            packet_id:  packet.id,
                            issue_code: 'UNKNOWN_CONTROLLER',
                            details:    `Controller "${ptsId}" is not registered in stations.json. Cannot determine timezone offset or attribute this packet to any station. Raw timestamp reported by controller: "${rawTimestamp}".`,
                        },
                    });
                    logger.warn(`  ⚠ Delivery #${sourcePosition}, packet #${packetPosition}: controller "${ptsId}" is not registered — flagged as UNKNOWN_CONTROLLER. Raw time: "${rawTimestamp}".`);
                    counters.issues++;
                    continue;
                }

                // ── UploadPumpTransaction ────────────────────────────────────
                if (packetType === 'UploadPumpTransaction') {
                    const saleCheck = validateSalePacket(data);
                    if (!saleCheck.valid) {
                        await tx.data_issue.create({
                            data: {
                                packet_id:  packet.id,
                                issue_code: 'INVALID_PACKET',
                                details:    `Sale packet at delivery #${sourcePosition}, position #${packetPosition} failed validation: ${saleCheck.reason}`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}, packet #${packetPosition}: INVALID_PACKET — ${saleCheck.reason}`);
                        counters.issues++;
                        continue;
                    }

                    const volume            = parseFloat(data.Volume);
                    const price             = parseFloat(data.Price);
                    const amount            = parseFloat(data.Amount);
                    const transactionNumber = String(data.Transaction);
                    const pump              = String(data.Pump);
                    const nozzle            = String(data.Nozzle);
                    const controllerTime    = data.DateTime;
                    const eventTimeUtc      = controllerTimeToUtc(controllerTime, station.utc_offset_minutes);
                    const saleKey           = `${ptsId}::${pump}::${transactionNumber}`;

                    // ── Check dedup first, then mismatch ────────────────────
                    // (Ordering matters: don't flag AMOUNT_MISMATCH on a packet
                    //  that will not become a sale row anyway.)

                    if (seenSales.has(saleKey)) {
                        await tx.data_issue.create({
                            data: {
                                packet_id:  packet.id,
                                issue_code: 'DUPLICATE_SALE',
                                details:    `Transaction #${transactionNumber} on pump ${pump} for station "${ptsId}" appeared more than once in this file. Only the first occurrence was recorded.`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} is a duplicate within this file — flagged as DUPLICATE_SALE.`);
                        counters.issues++;
                        continue;
                    }

                    const existingSale = await tx.sale.findUnique({
                        where: { pts_id_pump_transaction_number: { pts_id: ptsId, pump, transaction_number: transactionNumber } },
                    });

                    if (existingSale) {
                        const isDifferent =
                            decimalsDiffer(existingSale.volume_litres,       volume, 3) ||
                            decimalsDiffer(existingSale.price_sar_per_litre, price,  3) ||
                            decimalsDiffer(existingSale.amount_sar,          amount, 2);

                        if (isDifferent) {
                            await tx.data_issue.create({
                                data: {
                                    packet_id:  packet.id,
                                    issue_code: 'CONFLICTING_SALE',
                                    details:    `Transaction #${transactionNumber} on pump ${pump} already exists with different values. Stored: vol=${existingSale.volume_litres} L, price=${existingSale.price_sar_per_litre} SAR/L, amount=${existingSale.amount_sar} SAR. Incoming: vol=${volume} L, price=${price} SAR/L, amount=${amount} SAR. Incoming values were NOT applied.`,
                                },
                            });
                            logger.warn(`  ⚠ Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} conflicts with an existing record — flagged as CONFLICTING_SALE.`);
                            counters.issues++;
                        } else {
                            logger.debug(`  — Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} is an exact duplicate of an existing DB record — safely skipped.`);
                        }
                        seenSales.add(saleKey);
                        continue;
                    }

                    // Flag amount mismatch on new sales only (after dedup)
                    if (!isAmountValid(volume, price, amount)) {
                        await tx.data_issue.create({
                            data: {
                                packet_id:  packet.id,
                                issue_code: 'AMOUNT_MISMATCH',
                                details:    `Transaction #${transactionNumber} on pump ${pump}: reported amount ${amount} SAR does not match ${volume} L × ${price} SAR/L = ${(volume * price).toFixed(2)} SAR (tolerance: ${AMOUNT_TOLERANCE_SAR} SAR). Stored as-is.`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}: Transaction #${transactionNumber} on pump ${pump} has an amount mismatch (${amount} ≠ ${(volume * price).toFixed(2)}) — flagged as AMOUNT_MISMATCH.`);
                        counters.issues++;
                    }

                    await tx.sale.create({
                        data: {
                            source_packet_id:    packet.id,
                            pts_id:              ptsId,
                            pump,
                            nozzle,
                            transaction_number:  transactionNumber,
                            fuel_grade_name:     data.FuelGradeName,
                            controller_time:     new Date(controllerTime),
                            event_time_utc:      eventTimeUtc,
                            volume_litres:       volume,
                            price_sar_per_litre: price,
                            amount_sar:          amount,
                        },
                    });

                    logger.info(`  ✔ Recorded sale — Tx #${transactionNumber} | Pump ${pump} | ${data.FuelGradeName} | ${volume} L | ${amount} SAR | UTC: ${eventTimeUtc.toISOString()}`);
                    seenSales.add(saleKey);
                    counters.sales++;

                // ── ProbeMeasurements ────────────────────────────────────────
                } else if (packetType === 'ProbeMeasurements') {
                    const probeCheck = validateProbePacket(data);
                    if (!probeCheck.valid) {
                        await tx.data_issue.create({
                            data: {
                                packet_id:  packet.id,
                                issue_code: 'INVALID_PACKET',
                                details:    `Probe packet at delivery #${sourcePosition}, position #${packetPosition} failed validation: ${probeCheck.reason}`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}, packet #${packetPosition}: INVALID_PACKET — ${probeCheck.reason}`);
                        counters.issues++;
                        continue;
                    }

                    const controllerTime = data.DateTime;
                    const probeKey       = `${ptsId}::${data.Probe}::${controllerTime}`;
                    const eventTimeUtc   = controllerTimeToUtc(controllerTime, station.utc_offset_minutes);

                    // Within-run dedup
                    if (seenProbes.has(probeKey)) {
                        await tx.data_issue.create({
                            data: {
                                packet_id:  packet.id,
                                issue_code: 'DUPLICATE_SALE', // closest available code; probe readings share this concept
                                details:    `Probe reading for probe ${data.Probe} at "${controllerTime}" from station "${ptsId}" appeared more than once in this file. Only the first occurrence was recorded.`,
                            },
                        });
                        logger.warn(`  ⚠ Delivery #${sourcePosition}: Probe ${data.Probe} reading at "${controllerTime}" is a duplicate within this file — skipped.`);
                        counters.issues++;
                        continue;
                    }

                    // Cross-run dedup: same station, probe, and controller timestamp already in DB
                    const existingReading = await tx.probe_reading.findFirst({
                        where: { pts_id: ptsId, probe: String(data.Probe), controller_time: new Date(controllerTime) },
                    });

                    if (existingReading) {
                        logger.debug(`  — Delivery #${sourcePosition}: Probe ${data.Probe} reading at "${controllerTime}" already in DB — safely skipped.`);
                        seenProbes.add(probeKey);
                        continue;
                    }

                    await tx.probe_reading.create({
                        data: {
                            source_packet_id:      packet.id,
                            pts_id:                ptsId,
                            probe:                 String(data.Probe),
                            controller_time:       new Date(controllerTime),
                            event_time_utc:        eventTimeUtc,
                            product_volume_litres: parseFloat(data.ProductVolume),
                        },
                    });

                    logger.info(`  ✔ Recorded tank reading — Probe ${data.Probe} | ${parseFloat(data.ProductVolume).toLocaleString()} L in tank | UTC: ${eventTimeUtc.toISOString()}`);
                    seenProbes.add(probeKey);
                    counters.probes++;

                // ── Unrecognised packet type ─────────────────────────────────
                } else {
                    await tx.data_issue.create({
                        data: {
                            packet_id:  packet.id,
                            issue_code: 'INVALID_PACKET',
                            details:    `Packet at delivery #${sourcePosition}, position #${packetPosition} has an unrecognised type: "${packetType}".`,
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

    }, { timeout: 60_000 });

    logger.info('Transaction committed successfully. The database is ready.');
}

module.exports = { runLoader };

if (require.main === module) { runLoader().catch(console.error); }

