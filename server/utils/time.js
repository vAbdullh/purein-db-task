/**
 * Converts a naive local timestamp (from a controller's clock) to a UTC Date
 * using the station's utc_offset_minutes.
 *
 * The controller reports time in its local timezone without a zone suffix.
 * e.g., "2026-09-14T03:00:39" at utc_offset_minutes = 180 means UTC = local - 3h.
 *
 * @param {string} localIso - ISO 8601 datetime string WITHOUT timezone info.
 * @param {number} utcOffsetMinutes - Signed offset of controller clock from UTC.
 * @returns {Date} UTC Date object.
 */
function controllerTimeToUtc(localIso, utcOffsetMinutes) {
    // Parse as UTC first (appending Z treats it as UTC), then subtract the offset.
    const msAsIfUtc = new Date(localIso + 'Z').getTime();
    return new Date(msAsIfUtc - utcOffsetMinutes * 60 * 1000);
}

module.exports = { controllerTimeToUtc };
