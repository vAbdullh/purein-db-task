-- Registered stations and their controllers. PtsId stays as text to preserve leading zeros.
CREATE TABLE station (
    station_code TEXT PRIMARY KEY,
    station_name TEXT NOT NULL,
    pts_id TEXT NOT NULL UNIQUE,
    utc_offset_minutes SMALLINT NOT NULL
);

-- Every received delivery, in its original file position. The unique key makes reruns idempotent.
CREATE TABLE delivery (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_hash TEXT NOT NULL,
    source_position INTEGER NOT NULL CHECK (source_position > 0),
    pts_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    raw_message JSONB NOT NULL,
    UNIQUE (source_hash, source_position)
);

-- Every packet within a delivery, including duplicates and packets from unknown controllers.
CREATE TABLE packet (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id BIGINT NOT NULL REFERENCES delivery(id),
    packet_position INTEGER NOT NULL CHECK (packet_position > 0),
    reported_packet_id INTEGER,
    packet_type TEXT NOT NULL,
    raw_packet JSONB NOT NULL,
    UNIQUE (delivery_id, packet_position)
);

-- Unique, reportable pump sales. Repeated deliveries do not create additional sale rows.
CREATE TABLE sale (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_packet_id BIGINT NOT NULL UNIQUE REFERENCES packet(id),
    pts_id TEXT NOT NULL REFERENCES station(pts_id),
    pump TEXT NOT NULL,
    nozzle TEXT NOT NULL,
    transaction_number TEXT NOT NULL,
    fuel_grade_name TEXT NOT NULL,
    controller_time TIMESTAMP NOT NULL,
    event_time_utc TIMESTAMPTZ NOT NULL,
    volume_litres NUMERIC(12, 3) NOT NULL CHECK (volume_litres >= 0),
    price_sar_per_litre NUMERIC(12, 3) NOT NULL CHECK (price_sar_per_litre >= 0),
    amount_sar NUMERIC(14, 2) NOT NULL CHECK (amount_sar >= 0),
    UNIQUE (pts_id, pump, transaction_number)
);

-- Tank inventory snapshots. These are stored separately and never added to sales totals.
CREATE TABLE probe_reading (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_packet_id BIGINT NOT NULL UNIQUE REFERENCES packet(id),
    pts_id TEXT NOT NULL REFERENCES station(pts_id),
    probe TEXT NOT NULL,
    controller_time TIMESTAMP NOT NULL,
    event_time_utc TIMESTAMPTZ NOT NULL,
    product_volume_litres NUMERIC(14, 3) NOT NULL
        CHECK (product_volume_litres >= 0)
);

-- Problems found while loading.
CREATE TABLE data_issue (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    packet_id BIGINT NOT NULL REFERENCES packet(id),
    issue_code TEXT NOT NULL CHECK (
        issue_code IN (
            'UNKNOWN_CONTROLLER',
            'DUPLICATE_SALE',
            'CONFLICTING_SALE',
            'AMOUNT_MISMATCH',
            'INVALID_PACKET'
        )
    ),
    details TEXT NOT NULL,
    UNIQUE (packet_id, issue_code)
);

-- Daily sales grouped by the calendar date in Riyadh.
CREATE VIEW daily_station_sales AS
SELECT
    st.station_code,
    (s.event_time_utc AT TIME ZONE 'Asia/Riyadh')::DATE AS riyadh_day,
    COUNT(*) AS sales_count,
    SUM(s.volume_litres) AS total_litres,
    SUM(s.amount_sar) AS total_sar
FROM sale s
JOIN station st ON st.pts_id = s.pts_id
GROUP BY st.station_code,
         (s.event_time_utc AT TIME ZONE 'Asia/Riyadh')::DATE;