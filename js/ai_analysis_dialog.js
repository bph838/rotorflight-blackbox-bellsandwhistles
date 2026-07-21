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
  // Whether the user has toggled the graph image to hidden - a standing preference that should stick
  // as they browse between entries/results, not just apply to whichever one was visible when clicked.
  var imageHidden = false;

  // Tuning session state. currentSession.entries holds only *completed* analyses - the newest one is
  // always the "Current" interactive entry (follow-ups allowed); everything before it is read-only
  // history. selectedEntryIndex === null means we're viewing the pending/not-yet-analyzed slot, which
  // is the only place a fresh Analyze can run (see AI_TUNING_SESSIONS design: "the current one will be
  // the only one that analysis can happen on").
  var currentSession = null;
  var currentSessionFilePath = null;
  var selectedEntryIndex = null;
  // The most recently captured (not-yet-analyzed) graph/config/instructions/model, kept separately
  // from the live working vars above so that browsing a read-only historical entry (which overwrites
  // those live vars for display) doesn't lose it - selectPendingSlot() below restores from these.
  var pendingImageDataUrl = null;
  var pendingConfigSummary = "";
  var pendingInstructions = "";
  var pendingModel = "claude-opus-4-8";
  // Number of entries that already existed when the session was created/opened. Entries at or after
  // this index are the ones actually produced in this run of the app; entries before it were loaded
  // from disk and must stay read-only forever, even if one of them happens to be the last entry.
  var sessionBaselineEntryCount = 0;
  // True whenever the in-memory session has analysis that hasn't made it to disk yet (a fresh Analyze
  // or follow-up happened since the session was created/opened/last saved). Drives the "unsaved
  // changes" prompt when the dialog is closed.
  var sessionDirty = false;
  var allowNextModalHide = false;

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
  var unsavedWarningElem = $(".ai-session-unsaved-warning", dialog);
  var unsavedSaveButton = $(".ai-session-unsaved-save", dialog);
  var unsavedDiscardButton = $(".ai-session-unsaved-discard", dialog);
  var unsavedCancelButton = $(".ai-session-unsaved-cancel", dialog);
  var detailsToggleButton = $(".ai-session-details-toggle", dialog);
  var detailsPanelElem = $(".ai-session-details-panel", dialog);
  var detailsGoalElem = $(".ai-session-details-goal", dialog);
  var detailsTotalCostElem = $(".ai-session-details-total-cost", dialog);

  function setBusy(isBusy) {
    loadingElem.toggle(isBusy);
    analyzeButton.prop("disabled", isBusy);
    followupButton.prop("disabled", isBusy);
    followupInput.prop("disabled", isBusy);
  }

  function computeCost(usedModel, usage) {
    var pricing = MODEL_PRICING[usedModel];
    if (!pricing || !usage) {
      return null;
    }
    var inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    var cacheReadTokens = usage.cache_read_input_tokens || 0;
    var outputTokens = usage.output_tokens || 0;
    return (
      (inputTokens / 1e6) * pricing[0] +
      (cacheReadTokens / 1e6) * pricing[0] * 0.1 +
      (outputTokens / 1e6) * pricing[1]
    );
  }

  function displayCost(cost) {
    if (cost === null) {
      costElem.hide().text("");
    } else {
      costElem.text("Estimated cost: $" + cost.toFixed(4)).show();
    }
  }

  // Shows the cost of the call that just finished, and - when it belongs to a session entry -
  // accumulates it onto that entry (initial analyze + any follow-ups) so the same figure keeps
  // showing whenever that entry is viewed later, current or read-only, not just right after the call.
  function showCost(usedModel, usage, entryForCost) {
    var cost = computeCost(usedModel, usage);
    displayCost(cost);

    if (cost !== null && entryForCost) {
      entryForCost.costUsd = (entryForCost.costUsd || 0) + cost;
      sessionDirty = true;
      renderSessionDetails();
    }
  }

  function showResultUi() {
    previewElem.addClass('compact').toggle(!imageHidden);
    toggleImageButton.show().text(imageHidden ? "Show graph" : "Hide graph");
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
      detailsToggleButton.hide();
      detailsPanelElem.hide();
      return;
    }

    sidebarElem.show();
    sessionToolbarSaveButton.prop("disabled", false);
    sessionStatusElem.text("Session: " + currentSession.sessionName);
    detailsToggleButton.show();
    renderSessionDetails();

    var entries = currentSession.entries;

    for (var i = 0; i < entries.length; i++) {
      (function (index) {
        var entry = entries[index];
        var isCurrent = isEntryInteractiveCurrent(index);

        var item = $('<div class="ai-session-entry"></div>')
          .toggleClass("active", selectedEntryIndex === index)
          .append(
            $('<span class="ai-session-entry-label"></span>').text(
              AITuningSession.formatEntryLabel(entry.timestamp) + (isCurrent ? " (Current)" : ""),
            ),
          );

        if (!isCurrent) {
          item.append($('<span class="ai-session-entry-readonly-tag"></span>').text("Read-only"));
        }

        var deleteButton = $(
          '<button type="button" class="ai-session-entry-delete" title="Delete this entry">' +
          '<span class="glyphicon glyphicon-trash" aria-hidden="true"></span></button>',
        );
        deleteButton.click(function (e) {
          e.stopPropagation();
          deleteEntry(index);
        });
        item.append(deleteButton);

        item.click(function () {
          selectEntry(index);
        });

        entryListElem.append(item);
      })(i);
    }

    // The pending "ready to analyze" slot stays in the list for as long as nothing has actually been
    // analyzed yet in this run of the app - it must not disappear just because the user is browsing a
    // different (read-only) entry, only once a real new entry takes its place.
    if (entries.length === sessionBaselineEntryCount) {
      var pendingItem = $('<div class="ai-session-entry"></div>')
        .toggleClass("active", selectedEntryIndex === null)
        .append($('<span class="ai-session-entry-label"></span>').text("Current (not yet analyzed)"));

      pendingItem.click(function () {
        selectPendingSlot();
      });

      entryListElem.append(pendingItem);
    }
  }

  // Refreshes the tuning goal / cost breakdown shown under the cog button. Safe to call whether or
  // not the panel is currently open - it just keeps the content ready for whenever it's toggled open.
  function renderSessionDetails() {
    if (!currentSession) {
      return;
    }

    detailsGoalElem.text(
      currentSession.tuningGoal ? "Tuning goal: " + currentSession.tuningGoal : "No tuning goal set.",
    );

    var total = 0;
    var entries = currentSession.entries;
    for (var i = 0; i < entries.length; i++) {
      total += entries[i].costUsd || 0;
    }

    detailsTotalCostElem.text("Total estimated cost: $" + total.toFixed(4));
  }

  detailsToggleButton.click(function () {
    detailsToggleButton.tooltip("hide");
    detailsPanelElem.toggle();
  });

  // Switches back to the pending/not-yet-analyzed slot after the user has been browsing a read-only
  // historical entry, restoring the graph/config/instructions/model that were actually captured for
  // analysis (selectEntry() below overwrites the live working vars to display history, so they can't
  // be trusted to still hold the pending capture).
  function selectPendingSlot() {
    selectedEntryIndex = null;
    imageDataUrl = pendingImageDataUrl;
    configSummary = pendingConfigSummary;
    model = pendingModel;

    instructionsElem.val(pendingInstructions);
    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[model] || model));
    previewElem.attr("src", imageDataUrl || "");
    displayCost(null);

    resetToPendingUi();
    renderSessionSidebar();
  }

  // Removes an entry from the session for good, after confirming with the user, and saves the result.
  function deleteEntry(index) {
    if (!currentSession) {
      return;
    }

    var entry = currentSession.entries[index];
    var confirmed = confirm(
      "Delete the entry from " + AITuningSession.formatEntryLabel(entry.timestamp) + "? This can't be undone.",
    );
    if (!confirmed) {
      return;
    }

    currentSession.entries.splice(index, 1);

    // Entries before the baseline boundary were loaded from disk - removing one of them shifts every
    // later index down by one, so the boundary has to shift with it to keep pointing at the same split.
    if (index < sessionBaselineEntryCount) {
      sessionBaselineEntryCount -= 1;
    }

    if (selectedEntryIndex === index) {
      // Was looking at the entry that just got deleted - nothing left to show it, back to pending.
      selectPendingSlot();
    } else if (selectedEntryIndex !== null && selectedEntryIndex > index) {
      // Still looking at a surviving entry, but its index shifted down by the removal.
      selectEntry(selectedEntryIndex - 1);
    } else {
      renderSessionSidebar();
    }

    sessionDirty = true;
    autoSaveIfDirty();
  }

  // True only for the single entry that was actually produced in this run of the app (not loaded from
  // a session file) and is still the newest one - the only entry that can take follow-up questions.
  function isEntryInteractiveCurrent(index) {
    return index === currentSession.entries.length - 1 && index >= sessionBaselineEntryCount;
  }

  // If the user already ran a single-shot analysis (today's default, no-session flow) before
  // creating/opening a tuning session, that result shouldn't just be thrown away by the reset to a
  // blank pending state below - this builds a session entry out of it so the caller can carry it
  // over as the session's first entry instead. Returns null if there's nothing to carry over, or if
  // a session was already active (in which case the live analysis already belongs to that session,
  // not to whatever new one is about to replace it).
  function buildEntryFromCurrentAnalysis(session) {
    if (currentSession || !conversationMessages || conversationMessages.length < 2) {
      return null;
    }

    var timestamp = new Date().toISOString();
    return {
      id: AITuningSession.makeEntryId(session, timestamp),
      timestamp: timestamp,
      configSummary: configSummary,
      instructions: instructionsElem.val() || "",
      model: model,
      conversationMessages: conversationMessages,
    };
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
    var isCurrent = isEntryInteractiveCurrent(index);

    selectedEntryIndex = index;
    imageDataUrl = extractEntryImageDataUrl(entry);
    configSummary = entry.configSummary;
    conversationMessages = entry.conversationMessages;
    model = entry.model || model;

    instructionsElem.val(entry.instructions || "");
    instructionsElem.prop("readonly", true);
    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[entry.model] || entry.model));

    errorElem.hide().text("");
    // Show this entry's own accumulated cost (initial analyze + any follow-ups it's had), not just
    // transiently right after a call - it should stay visible however the entry was reached, current
    // or read-only. Older entries saved before cost tracking existed simply have nothing to show.
    displayCost(typeof entry.costUsd === "number" ? entry.costUsd : null);
    followupInput.val("");

    analyzeButton.hide();
    // No point showing an empty read-only instructions box - hide it so there's more room for the
    // actual data (graph/conversation) when this entry didn't have any extra instructions.
    instructionsGroupElem.toggle(!!(entry.instructions && entry.instructions.trim()));
    previewElem.attr("src", imageDataUrl || "").addClass("compact").toggle(!imageHidden);
    toggleImageButton.show().text(imageHidden ? "Show graph" : "Hide graph");

    renderConversation();
    resultElem.show();

    if (isCurrent) {
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

    // Carry over an already-completed single-shot analysis (if any) as this session's first entry,
    // rather than losing it when the dialog resets to a blank pending state below.
    var carryOverEntry = buildEntryFromCurrentAnalysis(newSession);
    if (carryOverEntry) {
      newSession.entries.push(carryOverEntry);
    }

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
          sessionBaselineEntryCount = 0; // Brand new session - nothing loaded from disk yet.
          sessionDirty = false;

          if (carryOverEntry) {
            selectEntry(newSession.entries.length - 1);
          } else {
            resetToPendingUi();
          }

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
        // Must be computed before currentSession is reassigned below - it checks against the
        // *previous* (no-session) state to decide whether there's anything to carry over.
        var carryOverEntry = buildEntryFromCurrentAnalysis(loadedSession);

        currentSession = loadedSession;
        currentSessionFilePath = filePath;
        // Every entry already in the file was finalized in a previous run - none of them are ever
        // eligible to become "Current" here, even if one of them is last in the array. A carried-over
        // entry goes after them - it wasn't loaded from disk, so it's the new interactive "Current".
        sessionBaselineEntryCount = loadedSession.entries.length;

        if (carryOverEntry) {
          loadedSession.entries.push(carryOverEntry);
          sessionDirty = true; // this entry isn't part of the file we just loaded - needs saving
          selectEntry(loadedSession.entries.length - 1);
        } else {
          sessionDirty = false;
          resetToPendingUi();
        }

        renderSessionSidebar();
        autoSaveIfDirty();
      },
      function (message) {
        errorElem.text("Could not open session file: " + message).show();
      },
    );
  });

  // Saves currentSession to currentSessionFilePath (silently), or - in the unlikely case no path is
  // known yet - prompts for one via the native Save dialog first. Shared by the toolbar Save button
  // and the "unsaved changes" prompt shown when closing the dialog.
  function saveCurrentSession(onSaved, onError) {
    if (!currentSession) {
      return;
    }

    function doSave(filePath) {
      AITuningSession.saveToPath(
        currentSession,
        filePath,
        function () {
          currentSessionFilePath = filePath;
          sessionDirty = false;
          if (onSaved) {
            onSaved();
          }
        },
        function (message) {
          var text = "Could not save the session file: " + message;
          errorElem.text(text).show();
          if (onError) {
            onError(text);
          }
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
  }

  sessionToolbarSaveButton.click(function () {
    saveCurrentSession(function () {
      var originalText = sessionToolbarSaveButton.text();
      sessionToolbarSaveButton.text("Saved!");
      setTimeout(function () {
        sessionToolbarSaveButton.text(originalText);
      }, 1500);
    });
  });

  // The "Save current session" button is hidden - every change that touches the session (a fresh
  // analysis, a follow-up, the cost each adds) now saves itself immediately, so there's nothing left
  // for the user to remember to click. Only called once per user action, after all of that action's
  // mutations (e.g. both the new entry and its cost) have been applied, so it's a single write, not one
  // per mutation. If it fails, sessionDirty is left true by saveCurrentSession() so the "unsaved
  // changes" prompt on close still catches it.
  function autoSaveIfDirty() {
    if (!currentSession || !sessionDirty) {
      return;
    }

    saveCurrentSession(function () {
      var originalText = sessionStatusElem.text();
      sessionStatusElem.text(originalText + " (saved)");
      setTimeout(function () {
        sessionStatusElem.text(originalText);
      }, 1500);
    });
  }

  // Intercept the dialog closing (the header "x" and footer "Close" buttons both use Bootstrap's
  // data-dismiss="modal", which fires this event before actually hiding) to warn about unsaved
  // analysis rather than silently losing it.
  dialog.on("hide.bs.modal", function (event) {
    if (allowNextModalHide) {
      allowNextModalHide = false;
      return;
    }

    if (currentSession && sessionDirty) {
      event.preventDefault();
      unsavedWarningElem.show();
    }
  });

  unsavedCancelButton.click(function () {
    unsavedWarningElem.hide();
  });

  unsavedDiscardButton.click(function () {
    unsavedWarningElem.hide();
    allowNextModalHide = true;
    dialog.modal("hide");
  });

  unsavedSaveButton.click(function () {
    saveCurrentSession(function () {
      unsavedWarningElem.hide();
      allowNextModalHide = true;
      dialog.modal("hide");
    });
  });

  // --- Existing analysis / follow-up / copy behavior ----------------------------------------

  toggleImageButton.click(function () {
    var willShow = !previewElem.is(":visible");
    imageHidden = !willShow;
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
          sessionDirty = true;
          analyzeButton.hide();
          instructionsElem.prop("readonly", true);
          readonlyNoteElem.hide().text("");
        }

        renderConversation();
        showResultUi();
        showCost(model, usage, currentSession ? currentSession.entries[currentSession.entries.length - 1] : null);
        renderSessionSidebar();
        autoSaveIfDirty();
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
          sessionDirty = true;
        }

        followupInput.val("");
        renderConversation();
        closeFollowup();
        showCost(model, usage, currentSession && selectedEntryIndex !== null ? currentSession.entries[selectedEntryIndex] : null);
        autoSaveIfDirty();
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

    // .show() is always called with a freshly-captured graph, so this is by definition the new
    // pending slot - remember it separately so selectPendingSlot() can get back to it later even
    // after the live vars above get overwritten by browsing a read-only historical entry. Extra
    // instructions are intentionally never remembered between analyses - always start blank.
    pendingImageDataUrl = imageDataUrl;
    pendingConfigSummary = configSummary;
    pendingInstructions = "";
    pendingModel = model;

    modelElem.text("Model: " + (MODEL_DISPLAY_NAMES[model] || model));

    instructionsElem.val("");
    errorElem.hide().text("");
    costElem.hide().text("");
    followupInput.val("");
    unsavedWarningElem.hide();
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
