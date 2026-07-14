"use strict";

var marked = require('marked');

function AIAnalysisDialog(dialog, onSaveInstructions, onResult) {

    var that = this;

    var MODEL_DISPLAY_NAMES = {
        'claude-opus-4-8'  : 'Claude Opus 4.8',
        'claude-sonnet-5'  : 'Claude Sonnet 5',
        'claude-haiku-4-5' : 'Claude Haiku 4.5',
    };

    var imageDataUrl = null;
    var configSummary = '';
    var apiKey = '';
    var model = 'claude-opus-4-8';
    var cacheKey = null;

    var instructionsElem = $(".ai-analysis-instructions", dialog);
    var resultElem = $(".ai-analysis-result", dialog);
    var errorElem = $(".ai-analysis-error", dialog);
    var loadingElem = $(".ai-analysis-loading", dialog);
    var previewElem = $(".ai-analysis-preview", dialog);
    var modelElem = $(".ai-analysis-model", dialog);
    var analyzeButton = $(".ai-analysis-dialog-analyze", dialog);

    function setBusy(isBusy) {
        loadingElem.toggle(isBusy);
        analyzeButton.prop('disabled', isBusy);
    }

    analyzeButton.click(function() {

        analyzeButton.tooltip('hide');

        var instructions = instructionsElem.val();
        onSaveInstructions(instructions);

        if (!imageDataUrl) {
            errorElem.text('No step response graph is available to analyze.').show();
            return;
        }

        resultElem.hide().html('');
        errorElem.hide().text('');
        setBusy(true);

        AIAnalysis.analyze({
            apiKey: apiKey,
            model: model,
            imageDataUrl: imageDataUrl,
            configSummary: configSummary,
            instructions: instructions,
        }, function(resultText) {
            setBusy(false);
            resultElem.html(marked.parse(resultText)).show();
            previewElem.addClass('compact');
            onResult(cacheKey, resultText);
        }, function(errorMessage) {
            setBusy(false);
            errorElem.text(errorMessage).show();
        });
    });

    this.show = function(newImageDataUrl, newConfigSummary, newApiKey, newModel, savedInstructions, newCacheKey, cachedResult) {

        imageDataUrl = newImageDataUrl;
        configSummary = newConfigSummary;
        apiKey = newApiKey;
        model = newModel || 'claude-opus-4-8';
        cacheKey = newCacheKey;

        modelElem.text('Model: ' + (MODEL_DISPLAY_NAMES[model] || model));

        instructionsElem.val(savedInstructions || '');
        errorElem.hide().text('');
        setBusy(false);

        if (cachedResult) {
            resultElem.html(marked.parse(cachedResult)).show();
        } else {
            resultElem.hide().html('');
        }

        previewElem.toggleClass('compact', !!cachedResult);
        previewElem.attr('src', imageDataUrl || '');

        if (!apiKey) {
            errorElem.text('No API key configured. Add one under Settings → AI Analysis Settings.').show();
        }

        dialog.modal('show');
    };
}
