// Tolerance is configurable via .env so it can be reviewed without touching code.
const AMOUNT_TOLERANCE_SAR = parseFloat(process.env.AMOUNT_TOLERANCE_SAR ?? '0.05');

/**
 * Returns true if a value parses to a finite, non-negative number.
 */
function isPositiveNumber(value) {
    const n = parseFloat(value);
    return !isNaN(n) && isFinite(n) && n >= 0;
}

/**
 * Returns true if a value parses to any finite number (used for volumes that
 * must be >= 0 but also catches NaN and Infinity early).
 */
function isFiniteNumber(value) {
    const n = parseFloat(value);
    return !isNaN(n) && isFinite(n);
}

/**
 * Returns true if the string is a parseable ISO 8601 datetime without a timezone suffix.
 * The loader appends Z before parsing, so we validate using the same method.
 */
function isValidDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const d = new Date(dateStr + 'Z');
    return !isNaN(d.getTime());
}

/**
 * Checks whether the reported amount matches volume * price within the configured tolerance.
 */
function isAmountValid(volume, price, amount) {
    const expected = volume * price;
    return Math.abs(expected - amount) <= AMOUNT_TOLERANCE_SAR;
}

/**
 * Validates all required fields for a sale packet, including type and range checks.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateSalePacket(data) {
    const requiredPresent = ['Pump', 'Nozzle', 'Transaction', 'FuelGradeName', 'Volume', 'Price', 'Amount', 'DateTime'];
    for (const k of requiredPresent) {
        if (data[k] === undefined || data[k] === null || data[k] === '') {
            return { valid: false, reason: `Required field "${k}" is missing or empty.` };
        }
    }
    if (!isPositiveNumber(data.Volume))  return { valid: false, reason: `Volume "${data.Volume}" is not a valid non-negative number.` };
    if (!isPositiveNumber(data.Price))   return { valid: false, reason: `Price "${data.Price}" is not a valid non-negative number.` };
    if (!isPositiveNumber(data.Amount))  return { valid: false, reason: `Amount "${data.Amount}" is not a valid non-negative number.` };
    if (!isValidDate(data.DateTime))     return { valid: false, reason: `DateTime "${data.DateTime}" is not a parseable ISO 8601 datetime.` };
    return { valid: true };
}

/**
 * Validates all required fields for a probe packet, including type checks.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateProbePacket(data) {
    const requiredPresent = ['Probe', 'DateTime', 'ProductVolume'];
    for (const k of requiredPresent) {
        if (data[k] === undefined || data[k] === null || data[k] === '') {
            return { valid: false, reason: `Required field "${k}" is missing or empty.` };
        }
    }
    if (!isFiniteNumber(data.ProductVolume)) return { valid: false, reason: `ProductVolume "${data.ProductVolume}" is not a valid finite number.` };
    if (!isValidDate(data.DateTime))         return { valid: false, reason: `DateTime "${data.DateTime}" is not a parseable ISO 8601 datetime.` };
    return { valid: true };
}

module.exports = {
    AMOUNT_TOLERANCE_SAR,
    isAmountValid,
    validateSalePacket,
    validateProbePacket,
};
