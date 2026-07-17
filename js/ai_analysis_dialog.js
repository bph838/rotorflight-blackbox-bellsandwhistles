"use strict";

var marked = require("marked");

function AIAnalysisDialog(dialog, onSaveInstructions, onResult) {
  var that = this;

  var MODEL_DISPLAY_NAMES = {
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
  };

  // $ per million tokens: [input, output]
  var MODEL_PRICING = {
    "claude-opus-4-8": [5.00, 25.00],
    "claude-sonnet-5": [3.00, 15.00],
    "claude-haiku-4-5": [1.00, 5.00],
  };

  var imageDataUrl = null;
  var configSummary = "";
  var apiKey = "";
  var model = "claude-opus-4-8";
  var cacheKey = null;

  var instructionsElem = $(".ai-analysis-instructions", dialog);
  var resultElem = $(".ai-analysis-result", dialog);
  var errorElem = $(".ai-analysis-error", dialog);
  var loadingElem = $(".ai-analysis-loading", dialog);
  var previewElem = $(".ai-analysis-preview", dialog);
  var modelElem = $(".ai-analysis-model", dialog);
  var costElem = $(".ai-analysis-cost", dialog);
  var analyzeButton = $(".ai-analysis-dialog-analyze", dialog);
  var toggleImageButton = $(".ai-analysis-toggle-image", dialog);

  function setBusy(isBusy) {
    loadingElem.toggle(isBusy);
    analyzeButton.prop("disabled", isBusy);
  }

  function showCost(usedModel, usage) {
    var pricing = MODEL_PRICING[usedModel];
    if (!pricing || !usage) {
      costElem.hide().text("");
      return;
    }
    var inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    var cacheReadTokens = usage.cache_read_input_tokens || 0;
    var outputTokens = usage.output_tokens || 0;
    var cost =
      (inputTokens / 1e6) * pricing[0] +
      (cacheReadTokens / 1e6) * pricing[0] * 0.1 +
      (outputTokens / 1e6) * pricing[1];
    costElem.text("Estimated cost: $" + cost.toFixed(4)).show();
  }

  function showResultUi() {
    previewElem.addClass('compact').show();
    toggleImageButton.show().text("Hide graph");
  }

  toggleImageButton.click(function () {
    var willShow = !previewElem.is(":visible");
    previewElem.toggle(willShow);
    toggleImageButton.text(willShow ? "Hide graph" : "Show graph");
  });

  analyzeButton.click(function () {
    analyzeButton.tooltip("hide");

    var instructions = instructionsElem.val();
    onSaveInstructions(instructions);

    if (!imageDataUrl) {
      errorElem.text("No step response graph is available to analyze.").show();
      return;
    }

    resultElem.hide().html("");
    errorElem.hide().text("");
    costElem.hide().text("");
    setBusy(true);

    AIAnalysis.analyze(
      {
        apiKey: apiKey,
        model: model,
        imageDataUrl: imageDataUrl,
        configSummary: configSummary,
        instructions: instructions,
      },
      function (resultText, usage) {
        setBusy(false);
        resultElem.html(marked.parse(resultText)).show();
        showResultUi();
        showCost(model, usage);
        onResult(cacheKey, resultText);
      },
      function (errorMessage) {
        setBusy(false);
        errorElem.text(errorMessage).show();
      },
    );
  });

  this.show = function (
    newImageDataUrl,
    newConfigSummary,
    newApiKey,
    newModel,
    savedInstructions,
    newCacheKey,
    cachedResult,
  ) {
    imageDataUrl = newImageDataUrl;
    configSummary = newConfigSummary;
    apiKey = newApiKey;
    model = newModel || "claude-opus-4-8";
    cacheKey = newCacheKey;

    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[model] || model));

    instructionsElem.val(savedInstructions || "");
    errorElem.hide().text("");
    costElem.hide().text("");
    setBusy(false);

    if (cachedResult) {
      resultElem.html(marked.parse(cachedResult)).show();
      showResultUi();
    } else {
      resultElem.hide().html("");
      previewElem.removeClass("compact").show();
      toggleImageButton.hide();
    }

    previewElem.attr("src", imageDataUrl || "");

    if (!apiKey) {
      errorElem
        .text(
          "No API key configured. Add one under Settings → AI Analysis Settings.",
        )
        .show();
    }

    dialog.modal("show");
  };
}
