"use strict";

var AITuningSession = AITuningSession || {};

var SESSION_FORMAT_VERSION = 1;

/**
 * Sanitizes a string for safe use as a filename component (craft names, session names, etc).
 */
function sanitizeForFilename(text) {
    return (text || "")
        .replace(/[\\/:*?"<>|]/g, "")
        .trim()
        .replace(/\s+/g, "_") || "Unknown";
}

function pad2(n) {
    return ("0" + n).slice(-2);
}

/**
 * yyyyMMdd_HHmmss in local time, matching the general timestamp style used elsewhere in this app
 * (see js/screenshot.js) but with the session-file separator format the user asked for.
 */
function formatTimestampForFilename(date) {
    return (
        "" + date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate()) +
        "_" + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds())
    );
}

function md5(text) {
    var crypto = require("crypto");
    return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

/**
 * Builds the "Session_Tune_<CRAFT-NAME>_<yyyyMMdd>_<HHmmss>.json" filename for a new session.
 */
AITuningSession.buildFilename = function(sessionName, craftName, date) {
    date = date || new Date();
    return "Session_Tune_" + sanitizeForFilename(craftName) + "_" + formatTimestampForFilename(date) + ".json";
};

/**
 * Creates a brand new, empty tuning session ready to have entries added to it.
 */
var DEFAULT_TUNING_GOAL = "I want help tuning the PID settings on my RC helicopter to improve flight performance.";

AITuningSession.create = function(sessionName, tuningGoal, craftName) {
    var createdDate = new Date().toISOString();
    var trimmedGoal = (tuningGoal || "").trim();

    return {
        formatVersion: SESSION_FORMAT_VERSION,
        sessionId: md5((sessionName || "") + "|" + createdDate),
        sessionName: sessionName || "",
        tuningGoal: trimmedGoal || DEFAULT_TUNING_GOAL,
        craftName: craftName || "",
        createdDate: createdDate,
        entries: [], // each entry may also carry a costUsd, accumulated across its initial analyze + follow-ups
    };
};

/**
 * Builds a stable, unique id for a new entry within the given session.
 */
AITuningSession.makeEntryId = function(session, timestampIso) {
    return md5((session.sessionId || "") + "|" + timestampIso);
};

AITuningSession.serialize = function(session) {
    return JSON.stringify(session, null, 2);
};

/**
 * Parses and validates a session JSON file's contents, throwing a descriptive Error if the
 * file doesn't look like a tuning session.
 */
AITuningSession.parse = function(jsonText) {
    var session;

    try {
        session = JSON.parse(jsonText);
    } catch (e) {
        throw new Error("This file is not valid JSON: " + e.message);
    }

    if (!session || typeof session !== "object" || !Array.isArray(session.entries)) {
        throw new Error("This file doesn't look like an AI tuning session.");
    }

    return session;
};

AITuningSession.saveToPath = function(session, filePath, onDone, onError) {
    var fs = require("fs");

    fs.writeFile(filePath, AITuningSession.serialize(session), "utf8", function(err) {
        if (err) {
            onError(err.message || String(err));
        } else {
            onDone();
        }
    });
};

AITuningSession.loadFromPath = function(filePath, onDone, onError) {
    var fs = require("fs");

    fs.readFile(filePath, "utf8", function(err, data) {
        if (err) {
            onError(err.message || String(err));
            return;
        }

        try {
            onDone(AITuningSession.parse(data));
        } catch (e) {
            onError(e.message || String(e));
        }
    });
};

/**
 * Formats an ISO timestamp for display in the session sidebar entry list.
 */
function isSameLocalDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

AITuningSession.formatEntryLabel = function(timestampIso) {
    var date = new Date(timestampIso);

    if (isNaN(date.getTime())) {
        return timestampIso || "";
    }

    var time = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    var now = new Date();

    if (isSameLocalDay(date, now)) {
        return "Today " + time;
    }

    var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (isSameLocalDay(date, yesterday)) {
        return "Yesterday " + time;
    }

    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) + " " + time;
};

/**
 * Concatenates every historical entry's full conversation (image, prompt, initial reply, and
 * any follow-up Q&A) into one message list to give the AI the whole tuning history as context.
 *
 * A prompt-cache breakpoint is stamped onto the last content block of the last message, so that
 * repeated analyses/follow-ups within the same session reuse Anthropic's server-side cache for
 * this (unchanging) historical prefix instead of being re-processed/re-billed at full price
 * every time. Returns [] when there's no history yet.
 */
AITuningSession.buildHistoryMessages = function(entries) {
    var historyMessages = [];

    for (var i = 0; i < (entries || []).length; i++) {
        historyMessages = historyMessages.concat(entries[i].conversationMessages || []);
    }

    if (historyMessages.length === 0) {
        return historyMessages;
    }

    var lastMessage = historyMessages[historyMessages.length - 1];
    var blocks;

    if (typeof lastMessage.content === "string") {
        blocks = [{ type: "text", text: lastMessage.content }];
    } else {
        // Copy so we don't mutate the stored entry's content array in place.
        blocks = lastMessage.content.slice();
    }

    blocks[blocks.length - 1] = Object.assign({}, blocks[blocks.length - 1], {
        cache_control: { type: "ephemeral" },
    });

    historyMessages[historyMessages.length - 1] = Object.assign({}, lastMessage, { content: blocks });

    return historyMessages;
};
