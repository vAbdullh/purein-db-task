# Pure-IN Forecourt Loader

Reads controller messages from four fuel stations, loads them into PostgreSQL, and flags any data problems it finds along the way.

---

## Setup, Loader, and Report Commands

**Requirements:** Docker and Docker Compose installed.

1. Copy the environment template and fill in your values:
   ```bash
   cp .env.example .env
   ```

2. Build and start the services (Setup & Loader):
   ```bash
   docker-compose up -d --build
   ```

   On first run this will:
   - Start a PostgreSQL container
   - Apply the database migration (`db/schema.sql`)
   - Start the Node.js server
   - Run the data loader automatically (loads 119 deliveries, 206 packets).

3. Run the Loader manually again (to test idempotency):
   ```bash
   docker-compose exec server node loader/index.js
   ```

4. Run the Report:
   ```bash
   docker-compose exec server npm run report
   ```
   This prints the aggregated litres and SAR per station per Riyadh day.

5. To stop:
   ```bash
   docker-compose down
   ```

## Data Quality Decisions

- **Duplicates**: Handled strictly. Transaction numbers reused across pumps are kept as separate sales. Repeated deliveries (e.g. 4/9, 92/101) are loaded into `delivery` and `packet` but only inserted once into `sale` or `probe_reading`.
- **Unknown Controllers**: Packets from unregistered controllers are saved and flagged (`UNKNOWN_CONTROLLER`) but are excluded from the daily station report totals.
- **Data Integrity**: Delivery 51, Packet 1 reports an amount of 1,246.60 SAR which doesn't match the volume/price. The original reported amount is retained and flagged as `AMOUNT_MISMATCH` rather than implicitly corrected. The flagged amount is included in the totals.
- **Timezones**: The report converts the UTC event time to `Asia/Riyadh` for bucketing. For instance, Station D's sale on 2026-09-13 22:42:12 UTC appears correctly on September 14 in Riyadh.
- **Tank Readings**: Probe measurements (tank inventory) are preserved in their own table (`probe_reading`) and are strictly excluded from sales totals.

---

## Getting Started with Docker

**Requirements:** Docker and Docker Compose installed.

1. Copy the environment template and fill in your values:
   ```bash
   cp .env.example .env
   ```

2. Build and start the services:
   ```bash
   docker-compose up --build
   ```

   On first run this will:
   - Start a PostgreSQL container
   - Apply the database migration (`db/schema.sql`)
   - Start the Node.js server
   - Run the data loader automatically

3. To stop:
   ```bash
   docker-compose down
   ```

The database is persisted in a Docker named volume. Bringing the stack back up will not reload data already in the database.

---

## Schema

See [`db/schema.sql`](db/schema.sql) for the full table definitions.

The key tables are:

| Table | What it holds |
|---|---|
| `station` | The four registered stations and their controller clock offsets |
| `delivery` | Every raw message received, in file order, with the original JSON |
| `packet` | Every packet within each delivery, including duplicates |
| `sale` | One row per unique pump sale — duplicates do not create extra rows |
| `probe_reading` | Tank inventory snapshots, kept separate from sales |
| `data_issue` | Any problem found during loading, linked back to its packet |

---

## How Duplicate Insertion Is Prevented

The loader hashes the exact bytes of `messages.json` with SHA-256 to produce a `source_hash`. Each delivery is stored with `(source_hash, source_position)` as a unique key. If that combination is already in the database, the delivery is skipped entirely.

For sales, the unique key is `(pts_id, pump, transaction_number)`. If a sale with that identity already exists, it is not inserted again.

Running the loader a second time — against the same file or the same containers — changes nothing in the database.

---

## How Problems Are Detected and Flagged

Every problem is written as a row in the `data_issue` table, linked to the exact packet that caused it. The reported values are always stored as-is and never corrected silently.

| Issue code | When it is raised |
|---|---|
| `UNKNOWN_CONTROLLER` | The packet's `PtsId` is not in `stations.json`. The sale is excluded from reporting until the controller is registered. |
| `DUPLICATE_SALE` | The same `(pts_id, pump, transaction_number)` appeared more than once in the same file. Only the first occurrence is recorded. |
| `CONFLICTING_SALE` | The same sale identity already exists in the database but with different volume, price, or amount. The incoming values are not applied. |
| `AMOUNT_MISMATCH` | The reported `Amount` does not match `Volume × Price` within a 0.05 SAR tolerance. The original amount is kept. |
| `INVALID_PACKET` | A required field is missing or the packet type is not recognised. |

---

## Data Findings

See [`FINDINGS.md`](FINDINGS.md) for a detailed breakdown of the specific anomalies found in the source data, including duplicate deliveries, a suspicious amount, an unregistered controller, and timezone boundary cases.
