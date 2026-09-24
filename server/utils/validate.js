const AMOUNT_TOLERANCE = 0.05; // SAR — acceptable rounding difference

/**
 * Checks whether the reported amount matches volume * price within a small tolerance.
 * @param {number} volume
 * @param {number} price
 * @param {number} amount
 * @returns {boolean}
 */
function isAmountValid(volume, price, amount) {
    const expected = volume * price;
    return Math.abs(expected - amount) <= AMOUNT_TOLERANCE;
}

/**
 * Checks that all required fields for a sale packet are present and non-empty.
 * @param {object} data - The Data object from an UploadPumpTransaction packet.
 * @returns {boolean}
 */
function isSalePacketValid(data) {
    const required = ['Pump', 'Nozzle', 'Transaction', 'FuelGradeName', 'Volume', 'Price', 'Amount', 'DateTime'];
    return required.every((k) => data[k] !== undefined && data[k] !== null && data[k] !== '');
}

/**
 * Checks that all required fields for a probe packet are present.
 * @param {object} data - The Data object from a ProbeMeasurements packet.
 * @returns {boolean}
 */
function isProbePacketValid(data) {
    const required = ['Probe', 'DateTime', 'ProductVolume'];
    return required.every((k) => data[k] !== undefined && data[k] !== null && data[k] !== '');
}

module.exports = { isAmountValid, isSalePacketValid, isProbePacketValid };
