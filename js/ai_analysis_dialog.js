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
  var conversationMessages = null; // Full message history sent to/from the API, for follow-up questions

  var instructionsElem = $(".ai-analysis-instructions", dialog);
  var instructionsGroupElem = instructionsElem.closest(".form-group");
  var resultElem = $(".ai-analysis-result", dialog);
  var errorElem = $(".ai-analysis-error", dialog);
  var loadingElem = $(".ai-analysis-loading", dialog);
  var previewElem = $(".ai-analysis-preview", dialog);
  var modelElem = $(".ai-analysis-model", dialog);
  var costElem = $(".ai-analysis-cost", dialog);
  var analyzeButton = $(".ai-analysis-dialog-analyze", dialog);
  var toggleImageButton = $(".ai-analysis-toggle-image", dialog);
  var followupElem = $(".ai-analysis-followup", dialog);
  var followupInput = $(".ai-analysis-followup-input", dialog);
  var followupButton = $(".ai-analysis-followup-send", dialog);
  var followupToggleButton = $(".ai-analysis-followup-toggle", dialog);

  function setBusy(isBusy) {
    loadingElem.toggle(isBusy);
    analyzeButton.prop("disabled", isBusy);
    followupButton.prop("disabled", isBusy);
    followupInput.prop("disabled", isBusy);
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
    instructionsGroupElem.hide();
    followupToggleButton.show();
  }

  function openFollowup() {
    followupToggleButton.hide();
    followupElem.show();
    followupInput.focus();
  }

  // Renders the initial analysis plus any follow-up question/answer turns from conversationMessages.
  // conversationMessages[0] is the initial user message (image + prompt), so is not itself displayed.
  function renderConversation() {
    resultElem.html("");

    if (!conversationMessages || conversationMessages.length < 2) {
      resultElem.hide();
      return;
    }

    resultElem.append(
      $('<div class="ai-analysis-turn ai-analysis-turn-assistant"></div>').html(
        marked.parse(conversationMessages[1].content),
      ),
    );

    for (var i = 2; i < conversationMessages.length; i += 2) {
      var userMessage = conversationMessages[i];
      var assistantMessage = conversationMessages[i + 1];

      if (userMessage) {
        resultElem.append(
          $('<div class="ai-analysis-turn ai-analysis-turn-user"></div>').text(userMessage.content),
        );
      }
      if (assistantMessage) {
        resultElem.append(
          $('<div class="ai-analysis-turn ai-analysis-turn-assistant"></div>').html(
            marked.parse(assistantMessage.content),
          ),
        );
      }
    }

    resultElem.show();
  }

  toggleImageButton.click(function () {
    var willShow = !previewElem.is(":visible");
    previewElem.toggle(willShow);
    toggleImageButton.text(willShow ? "Hide graph" : "Show graph");
  });

  followupToggleButton.click(function () {
    openFollowup();
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
    followupElem.hide();
    followupToggleButton.hide();
    instructionsGroupElem.hide();
    conversationMessages = null;
    setBusy(true);

    AIAnalysis.analyze(
      {
        apiKey: apiKey,
        model: model,
        imageDataUrl: imageDataUrl,
        configSummary: configSummary,
        instructions: instructions,
      },
      function (resultText, usage, updatedMessages) {
        setBusy(false);
        conversationMessages = updatedMessages;
        renderConversation();
        showResultUi();
        showCost(model, usage);
        onResult(cacheKey, conversationMessages);
      },
      function (errorMessage) {
        setBusy(false);
        errorElem.text(errorMessage).show();
      },
    );
  });

  followupButton.click(function () {
    var question = followupInput.val();

    if (!question || !question.trim()) {
      return;
    }

    errorElem.hide().text("");
    costElem.hide().text("");
    setBusy(true);

    AIAnalysis.ask(
      {
        apiKey: apiKey,
        model: model,
        messages: conversationMessages,
        question: question,
      },
      function (resultText, usage, updatedMessages) {
        setBusy(false);
        conversationMessages = updatedMessages;
        followupInput.val("");
        renderConversation();
        showCost(model, usage);
        onResult(cacheKey, conversationMessages);
      },
      function (errorMessage) {
        setBusy(false);
        errorElem.text(errorMessage).show();
      },
    );
  });

  followupInput.keydown(function (e) {
    // Enter sends the question, Shift+Enter adds a newline
    if (e.which === 13 && !e.shiftKey) {
      e.preventDefault();
      followupButton.click();
    }
  });

  this.show = function (
    newImageDataUrl,
    newConfigSummary,
    newApiKey,
    newModel,
    savedInstructions,
    newCacheKey,
    cachedConversation,
  ) {
    imageDataUrl = newImageDataUrl;
    configSummary = newConfigSummary;
    apiKey = newApiKey;
    model = newModel || "claude-opus-4-8";
    cacheKey = newCacheKey;
    conversationMessages = cachedConversation || null;

    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[model] || model));

    instructionsElem.val(savedInstructions || "");
    errorElem.hide().text("");
    costElem.hide().text("");
    followupInput.val("");
    setBusy(false);

    if (conversationMessages && conversationMessages.length > 1) {
      renderConversation();
      showResultUi();
      if (conversationMessages.length > 2) {
        // Conversation already has follow-up turns - keep the input open rather than re-collapsing it
        openFollowup();
      } else {
        followupElem.hide();
      }
    } else {
      resultElem.hide().html("");
      previewElem.removeClass("compact").show();
      toggleImageButton.hide();
      instructionsGroupElem.show();
      followupElem.hide();
      followupToggleButton.hide();
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
