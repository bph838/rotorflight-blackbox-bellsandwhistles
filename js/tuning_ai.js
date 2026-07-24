"use strict";

/**
 * Sends step response images + flight log configuration to Claude for PID/filter tuning advice,
 * using the Anthropic API key/model configured under Settings -> AI Analysis Settings.
 */
var TuningAI = TuningAI || {};

(function() {

    // js/ai_models.json is the single source of truth for model ids/names/pricing - also read
    // directly by js/tuning_log_dialog.js (display names) and js/user_settings_dialog.js (the
    // model picker).
    // NW.js resolves require() paths relative to index.html, not this file's own directory.
    var AI_MODELS = require('./js/ai_models.json');
    var MODELS_BY_ID = {};
    AI_MODELS.models.forEach(function(m) {
        MODELS_BY_ID[m.id] = m;
    });

    TuningAI.DEFAULT_MODEL = AI_MODELS.defaultModel;

    function createClient(apiKey) {
        var Anthropic = require('@anthropic-ai/sdk');
        return new Anthropic({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true, // Desktop app: the user supplies their own key, stored locally
        });
    }

    function imageBase64FromDataUrl(dataUrl) {
        return (dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    }

    /**
     * Estimated cost in USD for one API response, from its `usage` object. Cache writes are
     * priced at the 5-minute-TTL premium (1.25x input) since that's what this app requests.
     */
    TuningAI.estimateCostUsd = function(model, usage) {
        var pricing = MODELS_BY_ID[model];
        if (!pricing || !usage) return 0;

        var cost = 0;
        cost += ((usage.input_tokens || 0) / 1e6) * pricing.pricePerMillionInputTokens;
        cost += ((usage.output_tokens || 0) / 1e6) * pricing.pricePerMillionOutputTokens;
        cost += ((usage.cache_creation_input_tokens || 0) / 1e6) * pricing.pricePerMillionInputTokens * 1.25;
        cost += ((usage.cache_read_input_tokens || 0) / 1e6) * pricing.pricePerMillionInputTokens * 0.1;

        return cost;
    };

    /**
     * options: { configSummary, instructions, expertMode }
     */
    TuningAI.buildPromptText = function(options) {
        var instructions = (options.instructions || '').trim() || '(No specific instructions given - provide general tuning suggestions.)';

        var text = (
            'You are helping tune the PID controller of an RC helicopter flight controller running Rotorflight ' +
            '(forked from Betaflight). Attached is a step response graph generated from a blackbox log, showing ' +
            'setpoint-vs-gyro tracking (Roll in red, Pitch in green, Yaw in blue) for the 0-500ms period after a ' +
            'stick input, with 1.0 on the y-axis representing perfect tracking.\n\n' +
            'Current flight controller configuration extracted from the log:\n' + options.configSummary + '\n\n' +
            'User instructions: ' + instructions + '\n\n' +
            'Analyse the attached step response graph and suggest specific, actionable PID and filter changes ' +
            'to address the user\'s instructions, referencing the actual curve shapes you see (overshoot, ' +
            'settling time, oscillation, delay) for each axis.\n\n'
        );

        if (options.expertMode) {
            text += (
                'Expert mode is enabled: beyond PID and filter changes, also review the rest of the configuration ' +
                'above for other settings worth adjusting - rate profiles, feedforward, TPA (throttle PID ' +
                'attenuation), I-term relax, RPM filtering, governor/collective settings, voltage sag ' +
                'compensation, mixer settings, and anything else that looks misconfigured or suboptimal given the ' +
                'behaviour shown in the step response. Flag these in addition to, not instead of, any PID/filter ' +
                'changes.\n\n'
            );
        }

        text += (
            'For every change you recommend, clearly state which setting to change in the Rotorflight Configurator ' +
            'and where to find it, using this format: the exact field name as it appears in the Configurator UI, ' +
            'the tab/page it lives on (e.g. PID Tuning, Filters, Rates), the current value (from the configuration ' +
            'above), and the new value you recommend. Do not just describe the change conceptually - name the ' +
            'actual Configurator setting for the user to go and edit.\n\n' +
            'Present any PID gain changes grouped by axis in this order: Roll, then Pitch, then Yaw, and within ' +
            'each axis give the gains in this order: P, I, D.\n\n' +
            'If earlier messages above contain step response graphs, configuration and analysis from previous ' +
            'entries in this tuning log, use that history to track what has already been tried and how the ' +
            'response changed as a result, rather than repeating suggestions that were already applied unless ' +
            'they still need further adjustment.'
        );

        return text;
    };

    function entryToHistoryContent(entry) {
        var content = [];

        if (entry.image) {
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: imageBase64FromDataUrl(entry.image) },
            });
        }

        var text = 'Step response captured ' + entry.timestamp + '\n\nConfiguration:\n' + (entry.config || '(none)');
        if (entry.notes) {
            text += '\n\nUser notes: ' + entry.notes;
        }

        content.push({ type: 'text', text: text });

        return content;
    }

    function lastAssistantText(entry) {
        var conversation = (entry.ai && entry.ai.conversation) || [];

        for (var i = conversation.length - 1; i >= 0; i--) {
            if (conversation[i].role === 'assistant') {
                return typeof conversation[i].content === 'string' ? conversation[i].content : null;
            }
        }

        return null;
    }

    /**
     * Turns every entry already in the log into a user/assistant message pair (image + config/notes,
     * plus that entry's own final AI answer if it has one), so a new request has the whole tuning
     * log's history as context. Pass excludingEntryId to leave out the entry currently being asked
     * about (it's supplied separately as the new message, not as history).
     */
    TuningAI.buildHistoryMessages = function(log, excludingEntryId) {
        var messages = [];
        var entries = (log && log.entries) || [];

        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (excludingEntryId && entry.id === excludingEntryId) continue;

            messages.push({ role: 'user', content: entryToHistoryContent(entry) });

            var assistantText = lastAssistantText(entry);
            if (assistantText) {
                messages.push({ role: 'assistant', content: assistantText });
            }
        }

        return messages;
    };

    function sendMessages(options, messages, onResult, onError) {
        var client;
        try {
            client = createClient(options.apiKey);
        } catch (e) {
            onError('Could not load the Anthropic SDK: ' + e.message);
            return;
        }

        var model = options.model || TuningAI.DEFAULT_MODEL;
        var requestParams = {
            model: model,
            max_tokens: 4096,
            messages: messages,
        };

        // Adaptive thinking isn't supported on every model (e.g. Haiku 4.5) - only request it where it's valid
        var modelInfo = MODELS_BY_ID[model];
        if (!modelInfo || modelInfo.supportsAdaptiveThinking) {
            requestParams.thinking = { type: 'adaptive' };
        }

        client.beta.messages.create(requestParams).then(function(response) {
            var text = '';
            for (var i = 0; i < response.content.length; i++) {
                if (response.content[i].type === 'text') {
                    text += response.content[i].text;
                }
            }
            text = text || '(No text response received)';

            var updatedMessages = messages.concat([{ role: 'assistant', content: text }]);
            var costUsd = TuningAI.estimateCostUsd(model, response.usage);
            onResult(text, updatedMessages, costUsd);
        }).catch(function(error) {
            onError((error && error.message) ? error.message : String(error));
        });
    }

    /**
     * Starts a new tuning-advice conversation about a single entry (its image + config summary),
     * with the rest of the tuning log's history prepended as context.
     *
     * options: { apiKey, model, historyMessages, entry: {image, config}, instructions, expertMode }
     * onResult(resultText, entryMessages, costUsd) - entryMessages is *this entry's own*
     * conversation (not including historyMessages/repeats of it) - keep it and pass it back into
     * TuningAI.ask() for follow-ups, and persist it as entry.ai.conversation. costUsd is this
     * call's estimated price - add it to any running total you're keeping for the entry.
     */
    TuningAI.analyze = function(options, onResult, onError) {
        if (!options.apiKey) {
            onError('No Anthropic API key configured. Add one under Settings → AI Analysis Settings.');
            return;
        }

        var historyMessages = options.historyMessages || [];
        var content = [];

        if (options.entry.image) {
            content.push({
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: imageBase64FromDataUrl(options.entry.image) },
            });
        }

        content.push({ type: 'text', text: TuningAI.buildPromptText({ configSummary: options.entry.config, instructions: options.instructions, expertMode: options.expertMode }) });

        var initialMessage = { role: 'user', content: content };

        sendMessages(options, historyMessages.concat([initialMessage]), function(text, updatedMessages, costUsd) {
            onResult(text, updatedMessages.slice(historyMessages.length), costUsd);
        }, onError);
    };

    /**
     * Continues an existing entry's conversation with a follow-up question.
     *
     * options: { apiKey, model, historyMessages, messages, question }
     * `messages` is this entry's own conversation so far (as returned by a previous analyze()/ask() call).
     * onResult(resultText, entryMessages, costUsd) - pass the updated entryMessages back in for
     * the next follow-up; costUsd is this call's estimated price.
     */
    TuningAI.ask = function(options, onResult, onError) {
        if (!options.apiKey) {
            onError('No Anthropic API key configured. Add one under Settings → AI Analysis Settings.');
            return;
        }

        var question = (options.question || '').trim();
        if (!question) {
            onError('Please enter a question.');
            return;
        }

        var historyMessages = options.historyMessages || [];
        var messages = (options.messages || []).concat([{ role: 'user', content: question }]);

        sendMessages(options, historyMessages.concat(messages), function(text, updatedMessages, costUsd) {
            onResult(text, updatedMessages.slice(historyMessages.length), costUsd);
        }, onError);
    };

})();
