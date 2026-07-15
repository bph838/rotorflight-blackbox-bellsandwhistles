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

/**
 * Sends the step response image, config summary and user instructions to Claude,
 * and reports back the text response (or an error message).
 *
 * options: { apiKey, imageDataUrl, configSummary, instructions }
 */
AIAnalysis.analyze = function(options, onResult, onError) {

    if (!options.apiKey) {
        onError('No API key configured. Add one under Settings → AI Analysis Settings.');
        return;
    }

    var Anthropic;
    try {
        Anthropic = require('@anthropic-ai/sdk');
    } catch (e) {
        onError('Could not load the Anthropic SDK: ' + e.message);
        return;
    }

    var base64Data = options.imageDataUrl.replace(/^data:image\/\w+;base64,/, '');

    var client = new Anthropic({
        apiKey: options.apiKey,
        dangerouslyAllowBrowser: true, // Desktop app: the user supplies their own key, stored locally
    });

    var instructions = (options.instructions || '').trim() || '(No specific instructions given - provide general tuning suggestions.)';

    var promptText =
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
        'actual Configurator setting for the user to go and edit.';

    var model = options.model || 'claude-opus-4-8';
    var requestParams = {
        model: model,
        max_tokens: 4096,
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: base64Data },
                },
                { type: 'text', text: promptText },
            ],
        }],
    };

    // Adaptive thinking isn't supported on every model (e.g. Haiku 4.5) - only request it where it's valid
    if (model !== 'claude-haiku-4-5') {
        requestParams.thinking = { type: 'adaptive' };
    }

    client.messages.create(requestParams).then(function(response) {
        var text = '';
        for (var i = 0; i < response.content.length; i++) {
            if (response.content[i].type === 'text') {
                text += response.content[i].text;
            }
        }
        onResult(text || '(No text response received)');
    }).catch(function(error) {
        onError((error && error.message) ? error.message : String(error));
    });
};
