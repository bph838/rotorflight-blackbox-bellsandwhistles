"use strict";

const
    STEP_RESPONSE_AXIS_NAMES        = ['roll', 'pitch', 'yaw'],
    STEP_RESPONSE_FRAME_LEN_SEC     = 1.0,     // length of each analysis window
    STEP_RESPONSE_SUPERPOS          = 4,       // window overlap factor (stride = frameLen / this)
    STEP_RESPONSE_LEN_SEC           = 0.5,     // length of step response to keep from each window
    STEP_RESPONSE_MIN_STICK_MOVEMENT= 20,      // deg/s peak-to-peak setpoint excitation required to accept a window
    STEP_RESPONSE_OUTLIER_SIGMA     = 2,       // reject windows deviating more than this many pointwise std-devs from the mean
    STEP_RESPONSE_MIN_WINDOWS       = 10,      // minimum accepted windows for a result to be considered valid
    STEP_RESPONSE_REG_FRACTION      = 0.01,    // Wiener deconvolution regularization, as a fraction of mean input power
    STEP_RESPONSE_MAX_LENGTH        = 300 * 1000 * 1000; // 5min, matches the Analyser's analysis length cap

var StepResponseCalc = StepResponseCalc || {
    _timeRange : {
            in: 0,
            out: STEP_RESPONSE_MAX_LENGTH
    },
    _blackBoxRate : 0,
    _flightLog : null,
    _sysConfig : null,
};

StepResponseCalc.initialize = function(flightLog, sysConfig) {

    this._flightLog = flightLog;
    this._sysConfig = sysConfig;

    var gyroRate = (1000000 / this._sysConfig['looptime']).toFixed(0);
    this._blackBoxRate = gyroRate * this._sysConfig['frameIntervalPNum'] / this._sysConfig['frameIntervalPDenom'];
    if (this._sysConfig.pid_process_denom != null) {
        this._blackBoxRate = this._blackBoxRate / this._sysConfig.pid_process_denom;
    }
};

StepResponseCalc.setInTime = function(time) {
    this._timeRange.in = time;
    return this._timeRange.in;
};

StepResponseCalc.setOutTime = function(time) {
    if ((time - this._timeRange.in) <= STEP_RESPONSE_MAX_LENGTH) {
        this._timeRange.out = time;
    } else {
        this._timeRange.out = this._timeRange.in + STEP_RESPONSE_MAX_LENGTH;
    }
    return this._timeRange.out;
};

/**
 * Calculates the averaged step response (setpoint -> gyro) for roll, pitch and yaw
 * over the currently configured time range, via windowed Wiener deconvolution.
 *
 * Returns { roll, pitch, yaw }, each { time, response, windowCount, valid }.
 */
StepResponseCalc.calculate = function() {
    var result = {};
    for (var axisIndex = 0; axisIndex < STEP_RESPONSE_AXIS_NAMES.length; axisIndex++) {
        result[STEP_RESPONSE_AXIS_NAMES[axisIndex]] = this._calculateAxis(axisIndex);
    }
    return result;
};

StepResponseCalc._getFlightChunks = function() {

    var logStart = this._timeRange.in || this._flightLog.getMinTime();
    var logEnd = this._timeRange.out || this._flightLog.getMaxTime();

    logEnd = (logEnd - logStart <= STEP_RESPONSE_MAX_LENGTH) ? logEnd : logStart + STEP_RESPONSE_MAX_LENGTH;

    return this._flightLog.getChunksInTimeRange(logStart, logEnd);
};

StepResponseCalc._getAxisSamples = function(axisIndex) {

    var allChunks = this._getFlightChunks();

    var FIELD_SETPOINT_INDEX = this._flightLog.getMainFieldIndexByName('setpoint[' + axisIndex + ']');
    var FIELD_GYRO_INDEX = this._flightLog.getMainFieldIndexByName('gyroADC[' + axisIndex + ']');

    if (FIELD_SETPOINT_INDEX == null || FIELD_GYRO_INDEX == null) {
        return { setpoint: new Float64Array(0), gyro: new Float64Array(0), count: 0 };
    }

    var maxSamples = STEP_RESPONSE_MAX_LENGTH / (1000 * 1000) * this._blackBoxRate;
    var setpoint = new Float64Array(maxSamples);
    var gyro = new Float64Array(maxSamples);

    var samplesCount = 0;
    for (var chunkIndex = 0; chunkIndex < allChunks.length; chunkIndex++) {
        var chunk = allChunks[chunkIndex];
        for (var frameIndex = 0; frameIndex < chunk.frames.length; frameIndex++) {
            setpoint[samplesCount] = chunk.frames[frameIndex][FIELD_SETPOINT_INDEX];
            gyro[samplesCount] = chunk.frames[frameIndex][FIELD_GYRO_INDEX];
            samplesCount++;
        }
    }

    return { setpoint: setpoint, gyro: gyro, count: samplesCount };
};

StepResponseCalc._hanningWindow = function(samples, size) {
    for (var i = 0; i < size; i++) {
        samples[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
};

StepResponseCalc._emptyResult = function(timeAxis, responseLenSamples) {
    return {
        time: timeAxis,
        response: new Float64Array(responseLenSamples),
        windowCount: 0,
        valid: false,
    };
};

StepResponseCalc._calculateAxis = function(axisIndex) {

    var responseLenSamples = Math.round(STEP_RESPONSE_LEN_SEC * this._blackBoxRate);
    var timeAxis = new Float64Array(responseLenSamples);
    for (var t = 0; t < responseLenSamples; t++) {
        timeAxis[t] = t / this._blackBoxRate;
    }

    var frameLen = Math.round(STEP_RESPONSE_FRAME_LEN_SEC * this._blackBoxRate);

    if (frameLen < responseLenSamples || frameLen < 2) {
        return this._emptyResult(timeAxis, responseLenSamples);
    }

    var samples = this._getAxisSamples(axisIndex);

    if (samples.count < frameLen) {
        return this._emptyResult(timeAxis, responseLenSamples);
    }

    var stride = Math.max(1, Math.round(frameLen / STEP_RESPONSE_SUPERPOS));

    var forwardFft = new FFT.complex(frameLen, false);
    var inverseFft = new FFT.complex(frameLen, true);

    var windowResponses = [];

    for (var start = 0; start + frameLen <= samples.count; start += stride) {

        var setpointWindow = samples.setpoint.slice(start, start + frameLen);
        var gyroWindow = samples.gyro.slice(start, start + frameLen);

        // Reject windows without enough stick excitation - deconvolution is meaningless without input
        var minSp = setpointWindow[0], maxSp = setpointWindow[0];
        for (var s = 1; s < frameLen; s++) {
            if (setpointWindow[s] < minSp) minSp = setpointWindow[s];
            if (setpointWindow[s] > maxSp) maxSp = setpointWindow[s];
        }
        if ((maxSp - minSp) < STEP_RESPONSE_MIN_STICK_MOVEMENT) {
            continue;
        }

        this._hanningWindow(setpointWindow, frameLen);
        this._hanningWindow(gyroWindow, frameLen);

        var X = new Float64Array(frameLen * 2); // setpoint spectrum
        var G = new Float64Array(frameLen * 2); // gyro spectrum
        forwardFft.simple(X, setpointWindow, 'real');
        forwardFft.simple(G, gyroWindow, 'real');

        // Regularization proportional to mean input power, avoids dividing by (near) zero
        // at frequencies the stick didn't excite.
        var meanPower = 0;
        for (var f = 0; f < frameLen; f++) {
            meanPower += X[2 * f] * X[2 * f] + X[2 * f + 1] * X[2 * f + 1];
        }
        meanPower /= frameLen;
        var reg = STEP_RESPONSE_REG_FRACTION * meanPower + 1e-9;

        // Wiener deconvolution: H = G * conj(X) / (X * conj(X) + reg)
        var H = new Float64Array(frameLen * 2);
        for (var k = 0; k < frameLen; k++) {
            var xr = X[2 * k], xi = X[2 * k + 1];
            var gr = G[2 * k], gi = G[2 * k + 1];

            var denom = xr * xr + xi * xi + reg;

            var numR = gr * xr + gi * xi;
            var numI = gi * xr - gr * xi;

            H[2 * k] = numR / denom;
            H[2 * k + 1] = numI / denom;
        }

        var impulse = new Float64Array(frameLen * 2);
        inverseFft.simple(impulse, H, 'complex');

        // Cumulative sum of the impulse response gives the step response. This library's
        // inverse transform is unnormalized (verified empirically), so divide by frameLen.
        var stepResponse = new Float64Array(responseLenSamples);
        var acc = 0;
        for (var n = 0; n < responseLenSamples; n++) {
            acc += impulse[2 * n] / frameLen;
            stepResponse[n] = acc;
        }

        windowResponses.push(stepResponse);
    }

    if (windowResponses.length === 0) {
        return this._emptyResult(timeAxis, responseLenSamples);
    }

    // Pointwise mean and std-dev across all accepted windows
    var mean = new Float64Array(responseLenSamples);
    for (var w = 0; w < windowResponses.length; w++) {
        for (var n = 0; n < responseLenSamples; n++) {
            mean[n] += windowResponses[w][n];
        }
    }
    for (var n = 0; n < responseLenSamples; n++) {
        mean[n] /= windowResponses.length;
    }

    var std = new Float64Array(responseLenSamples);
    for (var w = 0; w < windowResponses.length; w++) {
        for (var n = 0; n < responseLenSamples; n++) {
            var d = windowResponses[w][n] - mean[n];
            std[n] += d * d;
        }
    }
    for (var n = 0; n < responseLenSamples; n++) {
        std[n] = Math.sqrt(std[n] / windowResponses.length);
    }

    // Single-pass outlier rejection: drop windows whose average deviation from the mean
    // (in units of the pointwise std-dev) exceeds STEP_RESPONSE_OUTLIER_SIGMA
    var accepted = [];
    for (var w = 0; w < windowResponses.length; w++) {
        var totalDeviation = 0;
        var countedPoints = 0;
        for (var n = 0; n < responseLenSamples; n++) {
            if (std[n] > 1e-9) {
                totalDeviation += Math.abs(windowResponses[w][n] - mean[n]) / std[n];
                countedPoints++;
            }
        }
        if (countedPoints === 0 || (totalDeviation / countedPoints) <= STEP_RESPONSE_OUTLIER_SIGMA) {
            accepted.push(windowResponses[w]);
        }
    }

    if (accepted.length === 0) {
        accepted = windowResponses;
    }

    var finalResponse = new Float64Array(responseLenSamples);
    for (var w = 0; w < accepted.length; w++) {
        for (var n = 0; n < responseLenSamples; n++) {
            finalResponse[n] += accepted[w][n];
        }
    }
    for (var n = 0; n < responseLenSamples; n++) {
        finalResponse[n] /= accepted.length;
    }

    return {
        time: timeAxis,
        response: finalResponse,
        windowCount: accepted.length,
        valid: accepted.length >= STEP_RESPONSE_MIN_WINDOWS,
    };
};
