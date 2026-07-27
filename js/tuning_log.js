"use strict";

/**
 * Model + on-disk persistence for a "Tuning Log": a simple JSON file recording a history of
 * step response captures (image + flight log configuration + notes) for a helicopter, so
 * changes can be tracked over time and replayed as context for AI tuning advice.
 */
var TuningLog = TuningLog || {};

(function() {

    function md5(text) {
        var crypto = require('crypto');
        return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
    }

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    TuningLog.makeId = function(timestampIso) {
        return md5(timestampIso);
    };

    TuningLog.create = function(name, craftName) {
        var createdDate = new Date().toISOString();

        return {
            formatVersion: 1,
            logId: md5((name || '') + '|' + createdDate),
            name: name || craftName || 'Tuning Log',
            craftName: craftName || '',
            createdDate: createdDate,
            entries: [],
        };
    };

    /**
     * Flattens a flight log's system configuration (PID gains, filters, rates, etc.) into a
     * readable text block, both for display and as context given to the AI.
     */
    TuningLog.buildConfigSummary = function(sysConfig) {
        var lines = [];
        var keys = Object.keys(sysConfig || {}).sort();

        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var value = sysConfig[key];

            if (value === null || value === undefined || typeof value === 'function') {
                continue;
            }

            try {
                lines.push(key + ': ' + JSON.stringify(value));
            } catch (e) {
                // Skip values that can't be serialized
            }
        }

        return lines.join('\n');
    };

    /**
     * TuningLogDialog displays timestamps by reading their UTC components verbatim (so a flight
     * log's own recorded "Log start datetime" - already the intended display value - isn't shifted
     * by the viewer's local timezone; see formatTimestamp in tuning_log_dialog.js). Real Date
     * objects like a file's mtime carry a true instant rather than a verbatim wall-clock value, so
     * before handing one to that display code we re-label it: shift it so its UTC components read
     * as the *local* wall-clock digits, matching what e.g. Windows Explorer shows for the file.
     */
    function asUtcLabeledLocalTime(date) {
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    }

    /**
     * The flight log's own recorded start time (rather than whenever the user happened to click
     * Capture) so the same flight log always produces the same timestamp/id, wherever it's
     * captured from - that keeps ids checkable/deduplicable against a given log.
     *
     * Flight controllers without an RTC report the header as "0000-01-01T00:00:00.000+00:00"
     * instead of omitting it, which parses as a valid (but useless) Date - that would otherwise
     * make every such log collide on the same id. When the header is missing or is that sentinel,
     * fall back to the log file's last-modified time (filePath) - not creation time, since that
     * gets reset to "now" when a log is copied off an SD card, while last-modified survives the
     * copy - and finally to the current time if that isn't available either.
     */
    TuningLog.logTimestamp = function(sysConfig, filePath) {
        var raw = sysConfig && sysConfig['Log start datetime'];

        if (raw) {
            var parsed = new Date(raw);
            if (!isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2000) {
                return parsed.toISOString();
            }
        }

        if (filePath) {
            try {
                var mtime = require('fs').statSync(filePath).mtime;
                if (mtime && !isNaN(mtime.getTime())) {
                    return asUtcLabeledLocalTime(mtime).toISOString();
                }
            } catch (e) {
                // Path not accessible - fall through to current time
            }
        }

        return asUtcLabeledLocalTime(new Date()).toISOString();
    };

    /**
     * options: { image, config, notes, craftName, timestamp }
     */
    TuningLog.addEntry = function(log, options) {
        var timestamp = options.timestamp || new Date().toISOString();

        var entry = {
            id: TuningLog.makeId(timestamp),
            timestamp: timestamp,
            craftName: options.craftName || '',
            image: options.image,
            config: options.config || '',
            notes: options.notes || '',
        };

        if (options.ai) {
            entry.ai = options.ai;
        }

        log.entries.push(entry);

        return entry;
    };

    TuningLog.buildFilename = function(log) {
        var now = new Date();
        var stamp = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
            '_' + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());

        var safeName = (log.name || 'TuningLog').replace(/[^a-z0-9_\-]+/gi, '_');

        return 'RF_TUNING_LOG_' + safeName + '_' + stamp + '.json';
    };

    TuningLog.saveToPath = function(log, filePath, onDone, onError) {
        var fs = require('fs');

        fs.writeFile(filePath, JSON.stringify(log, null, 2), 'utf8', function(err) {
            if (err) {
                if (onError) onError(err);
                return;
            }

            if (onDone) onDone();
        });
    };

    /**
     * Returns an error message if `log` doesn't look like a tuning log file, or null if it's
     * fine to use. Guards against a user picking an unrelated JSON file (or a corrupted one) in
     * the "Open" dialog - without this, e.g. a `null` or non-object `entries` element would
     * later throw when code like entryCost() or findEntryIndexById() dereferences it directly.
     */
    function validationError(log) {
        if (!log || typeof log !== 'object' || Array.isArray(log)) {
            return 'This file is not a tuning log.';
        }

        if (typeof log.formatVersion !== 'number') {
            return 'This file is not a tuning log.';
        }

        if (log.entries !== undefined) {
            if (!Array.isArray(log.entries)) {
                return 'This file is not a tuning log (its "entries" field is malformed).';
            }

            for (var i = 0; i < log.entries.length; i++) {
                if (!log.entries[i] || typeof log.entries[i] !== 'object') {
                    return 'This file is not a tuning log (its "entries" field is malformed).';
                }
            }
        }

        return null;
    }

    TuningLog.loadFromPath = function(filePath, onDone, onError) {
        var fs = require('fs');

        fs.readFile(filePath, 'utf8', function(err, data) {
            if (err) {
                if (onError) onError(err);
                return;
            }

            var log;
            try {
                log = JSON.parse(data);
            } catch (e) {
                if (onError) onError(e);
                return;
            }

            var error = validationError(log);
            if (error) {
                if (onError) onError(new Error(error));
                return;
            }

            log.entries = log.entries || [];

            if (onDone) onDone(log);
        });
    };

})();
