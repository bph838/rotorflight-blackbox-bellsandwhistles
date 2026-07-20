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
  var craftName = "";

  // Tuning session state. currentSession.entries holds only *completed* analyses - the newest one is
  // always the "Current" interactive entry (follow-ups allowed); everything before it is read-only
  // history. selectedEntryIndex === null means we're viewing the pending/not-yet-analyzed slot, which
  // is the only place a fresh Analyze can run (see AI_TUNING_SESSIONS design: "the current one will be
  // the only one that analysis can happen on").
  var currentSession = null;
  var currentSessionFilePath = null;
  var selectedEntryIndex = null;

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
  var copyTextButton = $(".ai-analysis-copy-text", dialog);
  var copyImageButton = $(".ai-analysis-copy-image", dialog);
  var followupElem = $(".ai-analysis-followup", dialog);
  var followupInput = $(".ai-analysis-followup-input", dialog);
  var followupButton = $(".ai-analysis-followup-send", dialog);
  var followupToggleButton = $(".ai-analysis-followup-toggle", dialog);
  var readonlyNoteElem = $(".ai-analysis-readonly-note", dialog);

  var sessionToolbarNewButton = $(".ai-session-new", dialog);
  var sessionToolbarOpenButton = $(".ai-session-open", dialog);
  var sessionToolbarSaveButton = $(".ai-session-save", dialog);
  var sessionStatusElem = $(".ai-session-status", dialog);
  var sidebarElem = $(".ai-session-sidebar", dialog);
  var sidebarToggleButton = $(".ai-session-sidebar-toggle", dialog);
  var entryListElem = $(".ai-session-entry-list", dialog);
  var createFormElem = $(".ai-session-create-form", dialog);
  var sessionNameInput = $(".ai-session-name-input", dialog);
  var sessionGoalInput = $(".ai-session-goal-input", dialog);
  var createConfirmButton = $(".ai-session-create-confirm", dialog);
  var createCancelButton = $(".ai-session-create-cancel", dialog);
  var openFileInput = $(".ai-session-open-input", dialog);
  var saveFileInput = $(".ai-session-save-input", dialog);

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

  function closeFollowup() {
    followupElem.hide();
    followupToggleButton.show();
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

  // --- Tuning session sidebar / state -------------------------------------------------------

  function renderSessionSidebar() {
    entryListElem.html("");

    if (!currentSession) {
      sidebarElem.hide();
      sessionStatusElem.text("No tuning session open");
      sessionToolbarSaveButton.prop("disabled", true);
      return;
    }

    sidebarElem.show();
    sessionToolbarSaveButton.prop("disabled", false);
    sessionStatusElem.text(
      "Session: " + currentSession.sessionName +
      (currentSession.tuningGoal ? " — " + currentSession.tuningGoal : ""),
    );

    var entries = currentSession.entries;

    for (var i = 0; i < entries.length; i++) {
      (function (index) {
        var entry = entries[index];
        var isLast = index === entries.length - 1;

        var item = $('<div class="ai-session-entry"></div>')
          .toggleClass("active", selectedEntryIndex === index)
          .append(
            $('<span class="ai-session-entry-label"></span>').text(
              AITuningSession.formatEntryLabel(entry.timestamp) + (isLast ? " (Current)" : ""),
            ),
          );

        if (!isLast) {
          item.append($('<span class="ai-session-entry-readonly-tag"></span>').text("Read-only"));
        }

        item.click(function () {
          selectEntry(index);
        });

        entryListElem.append(item);
      })(i);
    }

    if (selectedEntryIndex === null) {
      entryListElem.append(
        $('<div class="ai-session-entry active"></div>').append(
          $('<span class="ai-session-entry-label"></span>').text("Current (not yet analyzed)"),
        ),
      );
    }
  }

  // Resets the dialog to the "pending" state: no entry selected, ready for a fresh Analyze.
  // Used both when no session is active (today's default behavior) and whenever a session-aware
  // .show() call, Create, or Open needs a clean slate to analyze into.
  function resetToPendingUi() {
    selectedEntryIndex = null;
    conversationMessages = null;

    resultElem.hide().html("");
    previewElem.removeClass("compact").show();
    toggleImageButton.hide();
    instructionsGroupElem.show();
    instructionsElem.prop("readonly", false);
    analyzeButton.show();
    followupElem.hide();
    followupToggleButton.hide();
    readonlyNoteElem.hide().text("");
  }

  // Recovers the step response image from an entry's stored conversation (the image lives in
  // conversationMessages[0]'s content, since it has to be there to be resent as history) rather than
  // from a separately-stored copy. Falls back to entry.imageDataUrl for session files saved by an
  // older version of this app that duplicated the image into a top-level field.
  function extractEntryImageDataUrl(entry) {
    var firstMessage = entry.conversationMessages && entry.conversationMessages[0];
    var blocks = firstMessage && firstMessage.content;

    if (Array.isArray(blocks)) {
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].type === "image") {
          return "data:" + blocks[i].source.media_type + ";base64," + blocks[i].source.data;
        }
      }
    }

    return entry.imageDataUrl || null;
  }

  // Switches the dialog to display a specific (already-analyzed) session entry. The most recent
  // entry stays interactive (follow-ups allowed); everything earlier is strictly read-only.
  function selectEntry(index) {
    var entries = currentSession.entries;
    var entry = entries[index];
    var isLast = index === entries.length - 1;

    selectedEntryIndex = index;
    imageDataUrl = extractEntryImageDataUrl(entry);
    configSummary = entry.configSummary;
    conversationMessages = entry.conversationMessages;
    model = entry.model || model;

    instructionsElem.val(entry.instructions || "");
    instructionsElem.prop("readonly", true);
    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[entry.model] || entry.model));

    errorElem.hide().text("");
    costElem.hide().text("");
    followupInput.val("");

    analyzeButton.hide();
    instructionsGroupElem.show();
    previewElem.attr("src", imageDataUrl || "").removeClass("compact").show();
    toggleImageButton.hide();

    renderConversation();
    resultElem.show();

    if (isLast) {
      readonlyNoteElem.hide().text("");
      followupElem.hide();
      followupToggleButton.toggle(!!(conversationMessages && conversationMessages.length > 1));
    } else {
      readonlyNoteElem
        .text(
          "Read-only historical entry from " + AITuningSession.formatEntryLabel(entry.timestamp) +
          ". Select “Current” to run a new analysis, or the most recent entry to continue asking follow-up questions.",
        )
        .show();
      followupElem.hide();
      followupToggleButton.hide();
    }

    renderSessionSidebar();
  }

  function craftNameForSession() {
    return craftName || (currentSession && currentSession.craftName) || "UnknownCraft";
  }

  sidebarToggleButton.click(function () {
    sidebarElem.toggleClass("collapsed");
    sidebarToggleButton.html(sidebarElem.hasClass("collapsed") ? "&raquo;" : "&laquo;");
  });

  sessionToolbarNewButton.click(function () {
    errorElem.hide().text("");
    sessionNameInput.val("");
    sessionGoalInput.val("");
    createFormElem.show();
    sessionNameInput.focus();
  });

  createCancelButton.click(function () {
    createFormElem.hide();
  });

  createConfirmButton.click(function () {
    var sessionName = sessionNameInput.val().trim();
    var tuningGoal = sessionGoalInput.val().trim();

    if (!sessionName) {
      errorElem.text("Please enter a name for the tuning session.").show();
      return;
    }

    var newSession = AITuningSession.create(sessionName, tuningGoal, craftNameForSession());
    var suggestedFilename = AITuningSession.buildFilename(
      sessionName,
      craftNameForSession(),
      new Date(newSession.createdDate),
    );

    saveFileInput.attr("nwsaveas", suggestedFilename);
    saveFileInput.off("change").one("change", function () {
      var filePath = this.value;
      this.value = "";

      if (!filePath) {
        return;
      }

      AITuningSession.saveToPath(
        newSession,
        filePath,
        function () {
          currentSession = newSession;
          currentSessionFilePath = filePath;
          resetToPendingUi();
          renderSessionSidebar();
        },
        function (message) {
          errorElem.text("Could not save the new session file: " + message).show();
        },
      );
    });
    saveFileInput.click();

    createFormElem.hide();
  });

  sessionToolbarOpenButton.click(function () {
    errorElem.hide().text("");
    openFileInput.val("");
    openFileInput.click();
  });

  openFileInput.change(function () {
    var file = this.files && this.files[0];
    if (!file) {
      return;
    }

    var filePath = file.path;

    AITuningSession.loadFromPath(
      filePath,
      function (loadedSession) {
        currentSession = loadedSession;
        currentSessionFilePath = filePath;
        resetToPendingUi();
        renderSessionSidebar();
      },
      function (message) {
        errorElem.text("Could not open session file: " + message).show();
      },
    );
  });

  sessionToolbarSaveButton.click(function () {
    if (!currentSession) {
      return;
    }

    function doSave(filePath) {
      AITuningSession.saveToPath(
        currentSession,
        filePath,
        function () {
          currentSessionFilePath = filePath;
          var originalText = sessionToolbarSaveButton.text();
          sessionToolbarSaveButton.text("Saved!");
          setTimeout(function () {
            sessionToolbarSaveButton.text(originalText);
          }, 1500);
        },
        function (message) {
          errorElem.text("Could not save the session file: " + message).show();
        },
      );
    }

    if (currentSessionFilePath) {
      doSave(currentSessionFilePath);
      return;
    }

    var suggestedFilename = AITuningSession.buildFilename(
      currentSession.sessionName,
      craftNameForSession(),
      new Date(),
    );

    saveFileInput.attr("nwsaveas", suggestedFilename);
    saveFileInput.off("change").one("change", function () {
      var filePath = this.value;
      this.value = "";
      if (filePath) {
        doSave(filePath);
      }
    });
    saveFileInput.click();
  });

  // --- Existing analysis / follow-up / copy behavior ----------------------------------------

  toggleImageButton.click(function () {
    var willShow = !previewElem.is(":visible");
    previewElem.toggle(willShow);
    toggleImageButton.text(willShow ? "Hide graph" : "Show graph");
  });

  function flashCopied(button, originalText) {
    button.text("Copied!");
    setTimeout(function () {
      button.text(originalText);
    }, 1500);
  }

  copyTextButton.click(function () {
    copyTextButton.tooltip("hide");

    var promptText = AIAnalysis.buildPromptText({
      configSummary: configSummary,
      instructions: instructionsElem.val(),
    });

    navigator.clipboard
      .writeText(promptText)
      .then(function () {
        flashCopied(copyTextButton, "Copy prompt");
      })
      .catch(function (error) {
        errorElem
          .text("Could not copy prompt to clipboard: " + ((error && error.message) || error))
          .show();
      });
  });

  copyImageButton.click(function () {
    copyImageButton.tooltip("hide");

    if (!imageDataUrl) {
      errorElem.text("No step response graph is available to copy.").show();
      return;
    }

    fetch(imageDataUrl)
      .then(function (response) {
        return response.blob();
      })
      .then(function (imageBlob) {
        return navigator.clipboard.write([new ClipboardItem({ "image/png": imageBlob })]);
      })
      .then(function () {
        flashCopied(copyImageButton, "Copy image");
      })
      .catch(function (error) {
        errorElem
          .text("Could not copy image to clipboard: " + ((error && error.message) || error))
          .show();
      });
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

    var historyMessages = currentSession ? AITuningSession.buildHistoryMessages(currentSession.entries) : [];
    var sessionContext = currentSession
      ? {
          sessionName: currentSession.sessionName,
          tuningGoal: currentSession.tuningGoal,
          iterationNumber: currentSession.entries.length + 1,
        }
      : null;

    AIAnalysis.analyze(
      {
        apiKey: apiKey,
        model: model,
        imageDataUrl: imageDataUrl,
        configSummary: configSummary,
        instructions: instructions,
        historyMessages: historyMessages,
        sessionContext: sessionContext,
      },
      function (resultText, usage, updatedMessages) {
        setBusy(false);
        conversationMessages = updatedMessages;

        if (currentSession) {
          var timestamp = new Date().toISOString();
          currentSession.entries.push({
            id: AITuningSession.makeEntryId(currentSession, timestamp),
            timestamp: timestamp,
            // The image already lives in conversationMessages[0]'s content (it has to, so it can be
            // resent as history) - don't also duplicate the ~100-200KB base64 blob up here.
            configSummary: configSummary,
            instructions: instructions,
            model: model,
            conversationMessages: conversationMessages,
          });
          selectedEntryIndex = currentSession.entries.length - 1;
          analyzeButton.hide();
          instructionsElem.prop("readonly", true);
          readonlyNoteElem.hide().text("");
        }

        renderConversation();
        showResultUi();
        showCost(model, usage);
        renderSessionSidebar();
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

    var historyMessages =
      currentSession && selectedEntryIndex !== null
        ? AITuningSession.buildHistoryMessages(currentSession.entries.slice(0, selectedEntryIndex))
        : [];

    AIAnalysis.ask(
      {
        apiKey: apiKey,
        model: model,
        messages: conversationMessages,
        question: question,
        historyMessages: historyMessages,
      },
      function (resultText, usage, updatedMessages) {
        setBusy(false);
        conversationMessages = updatedMessages;

        if (currentSession && selectedEntryIndex !== null) {
          currentSession.entries[selectedEntryIndex].conversationMessages = conversationMessages;
        }

        followupInput.val("");
        renderConversation();
        closeFollowup();
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
    newCraftName,
  ) {
    imageDataUrl = newImageDataUrl;
    configSummary = newConfigSummary;
    apiKey = newApiKey;
    model = newModel || "claude-opus-4-8";
    cacheKey = newCacheKey;
    craftName = newCraftName || "";

    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[model] || model));

    instructionsElem.val(savedInstructions || "");
    errorElem.hide().text("");
    costElem.hide().text("");
    followupInput.val("");
    setBusy(false);

    if (currentSession) {
      // A session is active: never clobber its entries here, just reset the pending/live working
      // state so this freshly-captured graph is ready to be analyzed as a brand new entry.
      resetToPendingUi();
    } else {
      conversationMessages = cachedConversation || null;

      if (conversationMessages && conversationMessages.length > 1) {
        renderConversation();
        showResultUi();
        followupElem.hide();
      } else {
        resetToPendingUi();
      }
    }

    previewElem.attr("src", imageDataUrl || "");

    if (!apiKey) {
      errorElem
        .text(
          "No API key configured. Add one under Settings → AI Analysis Settings.",
        )
        .show();
    }

    renderSessionSidebar();
    dialog.modal("show");
  };
}
