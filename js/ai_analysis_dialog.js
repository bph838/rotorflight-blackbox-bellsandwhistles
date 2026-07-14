"use strict";

function AIAnalysisDialog(dialog, onSaveInstructions) {

    var that = this;

    var imageDataUrl = null;
    var configSummary = '';
    var apiKey = '';

    var instructionsElem = $(".ai-analysis-instructions", dialog);
    var resultElem = $(".ai-analysis-result", dialog);
    var errorElem = $(".ai-analysis-error", dialog);
    var loadingElem = $(".ai-analysis-loading", dialog);
    var previewElem = $(".ai-analysis-preview", dialog);
    var analyzeButton = $(".ai-analysis-dialog-analyze", dialog);

    function setBusy(isBusy) {
        loadingElem.toggle(isBusy);
        analyzeButton.prop('disabled', isBusy);
    }

    analyzeButton.click(function() {

        var instructions = instructionsElem.val();
        onSaveInstructions(instructions);

        if (!imageDataUrl) {
            errorElem.text('No step response graph is available to analyze.').show();
            return;
        }

        resultElem.hide().text('');
        errorElem.hide().text('');
        setBusy(true);

        AIAnalysis.analyze({
            apiKey: apiKey,
            imageDataUrl: imageDataUrl,
            configSummary: configSummary,
            instructions: instructions,
        }, function(resultText) {
            setBusy(false);
            resultElem.text(resultText).show();
        }, function(errorMessage) {
            setBusy(false);
            errorElem.text(errorMessage).show();
        });
    });

    this.show = function(newImageDataUrl, newConfigSummary, newApiKey, savedInstructions) {

        imageDataUrl = newImageDataUrl;
        configSummary = newConfigSummary;
        apiKey = newApiKey;

        instructionsElem.val(savedInstructions || '');
        resultElem.hide().text('');
        errorElem.hide().text('');
        setBusy(false);

        previewElem.attr('src', imageDataUrl || '');

        if (!apiKey) {
            errorElem.text('No API key configured. Add one under Settings → AI Analysis Settings.').show();
        }

        dialog.modal('show');
    };
}
