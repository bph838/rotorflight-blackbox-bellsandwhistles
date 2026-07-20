"use strict";

var AIAnalysis = AIAnalysis || {};

/**
 * Flattens the flight log's system configuration into a readable text block
 * (PID gains, filters, rates, etc.) to give the AI the context behind the graph.
 */
AIAnalysis.buildConfigSummary = function(sysConfig) {
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

function createClient(apiKey) {
    var Anthropic = require('@anthropic-ai/sdk');
    return new Anthropic({
        apiKey: apiKey,
        dangerouslyAllowBrowser: true, // Desktop app: the user supplies their own key, stored locally
    });
}

/**
 * Builds the tuning prompt text sent alongside the step response image. Exposed so the UI can
 * also let the user copy the exact prompt (e.g. to paste into another AI chat).
 *
 * options: { configSummary, instructions, sessionContext: { sessionName, tuningGoal, iterationNumber } }
 */
AIAnalysis.buildPromptText = function(options) {
    var instructions = (options.instructions || '').trim() || '(No specific instructions given - provide general tuning suggestions.)';
    var sessionPreamble = '';

    if (options.sessionContext) {
        var ctx = options.sessionContext;
        sessionPreamble =
            'This is iteration ' + ctx.iterationNumber + ' of an ongoing PID tuning session, ' +
            'with the overall tuning goal: "' + ctx.tuningGoal + '". Earlier messages above contain the step response ' +
            'graph(s), configuration and your own previous analysis/recommendations from the earlier iteration(s) of this ' +
            'same session. Use that history to track what has already been tried and how the tracking changed as a result, ' +
            'rather than repeating suggestions that were already applied unless they still need further adjustment.\n\n';
    }

    return (
        sessionPreamble +
        'You are helping tune the PID controller of an RC helicopter flight controller running Rotorflight ' +
        '(forked from Betaflight). Attached is a step response graph generated from a blackbox log, showing ' +
        'setpoint-vs-gyro tracking (Roll in red, Pitch in green, Yaw in blue) for the 0-500ms period after a ' +
        'stick input, with 1.0 on the y-axis representing perfect tracking.\n\n' +
        'Current flight controller configuration extracted from the log:\n' + options.configSummary + '\n\n' +
        'User instructions: ' + instructions + '\n\n' +
        'Analyse the attached step response graph and suggest specific, actionable PID and filter changes ' +
        'to address the user\'s instructions, referencing the actual curve shapes you see (overshoot, ' +
        'settling time, oscillation, delay) for each axis.\n\n' +
        'For every change you recommend, clearly state which setting to change in the Rotorflight Configurator ' +
        'and where to find it, using this format: the exact field name as it appears in the Configurator UI, ' +
        'the tab/page it lives on (e.g. PID Tuning, Filters, Rates), the current value (from the configuration ' +
        'above), and the new value you recommend. Do not just describe the change conceptually - name the ' +
        'actual Configurator setting for the user to go and edit.\n\n' +
        'Present any PID gain changes grouped by axis in this order: Roll, then Pitch, then Yaw, and within ' +
        'each axis give the gains in this order: P, I, D.\n\n' +
        'The user may ask follow-up questions about this analysis afterwards, so keep track of the reasoning ' +
        'behind your suggestions in case you need to refer back to it.'
    );
};

/**
 * Builds the initial user message (image + tuning prompt) that kicks off an analysis conversation.
 *
 * options: { imageDataUrl, configSummary, instructions }
 */
function buildInitialUserMessage(options) {
    var base64Data = options.imageDataUrl.replace(/^data:image\/\w+;base64,/, '');

    return {
        role: 'user',
        content: [
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: base64Data },
            },
            { type: 'text', text: AIAnalysis.buildPromptText(options) },
        ],
    };
}

/**
 * Sends the full conversation so far to Claude and reports back the new assistant text
 * (or an error message) along with the updated message history to persist for the next turn.
 *
 * options: { apiKey, model }
 */
function sendMessages(options, messages, onResult, onError) {
    var client;
    try {
        client = createClient(options.apiKey);
    } catch (e) {
        onError('Could not load the Anthropic SDK: ' + e.message);
        return;
    }

    var model = options.model || 'claude-opus-4-8';
    var requestParams = {
        model: model,
        max_tokens: 4096,
        messages: messages,
    };

    // Adaptive thinking isn't supported on every model (e.g. Haiku 4.5) - only request it where it's valid
    if (model !== 'claude-haiku-4-5') {
        requestParams.thinking = { type: 'adaptive' };
    }

    // client.beta.messages is used (rather than client.messages) because cache_control breakpoints
    // (see AITuningSession.buildHistoryMessages) are only supported on the beta messages resource in
    // this SDK version - it accepts the same params/response shape otherwise.
    client.beta.messages.create(requestParams).then(function(response) {
        var text = '';
        for (var i = 0; i < response.content.length; i++) {
            if (response.content[i].type === 'text') {
                text += response.content[i].text;
            }
        }
        text = text || '(No text response received)';

        var updatedMessages = messages.concat([{ role: 'assistant', content: text }]);
        onResult(text, response.usage, updatedMessages);
    }).catch(function(error) {
        onError((error && error.message) ? error.message : String(error));
    });
}

/**
 * Starts a new analysis conversation from the step response image, config summary and user instructions.
 *
 * options: { apiKey, model, imageDataUrl, configSummary, instructions, historyMessages, sessionContext }
 * `historyMessages`, when part of an active tuning session, is the prior entries' conversation history
 * (see AITuningSession.buildHistoryMessages) prepended so the AI has the whole tuning session as context
 * for this request only - it is NOT included in the returned `messages`, so callers can keep storing only
 * this entry's own conversation as a new session entry (prepending it again every time the whole session's
 * history is rebuilt would otherwise duplicate it).
 * onResult(resultText, usage, messages) - `messages` should be kept and passed back into AIAnalysis.ask()
 * for follow-up questions on this entry.
 */
AIAnalysis.analyze = function(options, onResult, onError) {

    if (!options.apiKey) {
        onError('No API key configured. Add one under Settings → AI Analysis Settings.');
        return;
    }

    var historyMessages = options.historyMessages || [];

    sendMessages(options, historyMessages.concat([buildInitialUserMessage(options)]), function(text, usage, updatedMessages) {
        onResult(text, usage, updatedMessages.slice(historyMessages.length));
    }, onError);
};

/**
 * Continues an existing analysis conversation with a follow-up question.
 *
 * options: { apiKey, model, messages, question, historyMessages }
 * `messages` is this entry's own conversation so far (NOT including any other session entries).
 * `historyMessages`, when part of an active tuning session, is prepended ahead of `messages` for this
 * request only - it is NOT included in the returned `messages`, so callers can keep storing only this
 * entry's own conversation (see AIAnalysis.analyze for why: storing the resolved history back onto an
 * entry would duplicate it next time the whole session's history is rebuilt).
 * onResult(resultText, usage, messages) - pass the updated `messages` back in for the next follow-up.
 */
AIAnalysis.ask = function(options, onResult, onError) {

    if (!options.apiKey) {
        onError('No API key configured. Add one under Settings → AI Analysis Settings.');
        return;
    }

    var question = (options.question || '').trim();
    if (!question) {
        onError('Please enter a question.');
        return;
    }

    var historyMessages = options.historyMessages || [];
    var messages = (options.messages || []).concat([{ role: 'user', content: question }]);

    sendMessages(options, historyMessages.concat(messages), function(text, usage, updatedMessages) {
        onResult(text, usage, updatedMessages.slice(historyMessages.length));
    }, onError);
};
