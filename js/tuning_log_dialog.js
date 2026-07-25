"use strict";

/**
 * Dialog controller for the Tuning Log: create/open a TuningLog JSON file, automatically capture
 * a step response entry for whichever flight log is currently loaded, flick through past entries,
 * and ask the AI for tuning advice on the current entry (with the rest of the log sent along as
 * history).
 *
 * dialog - the modal jQuery element (#dlgTuningLog)
 * getContext - function() -> { flightLog, graph, userSettings }, called on demand since these are
 *              reassigned by main.js after a flight log is loaded (not fixed at construction time).
 */
function TuningLogDialog(dialog, getContext) {
  var marked = require("marked");
  var prefs = new PrefStorage();
  // NW.js resolves require() paths relative to index.html, not this file's own directory.
  var AI_MODELS = require("./js/ai_models.json");

  var currentLog = null,
    currentPath = null,
    selectedIndex = -1, // -1 = the "current flight log" placeholder; otherwise an index into currentLog.entries
    creatingNew = false,
    configVisible = false,
    imageExpanded = false,
    apiKeyBannerDismissed = false,
    pendingEntryIds = {}; // entry.id -> true while an Ask AI request for that entry is in flight,
    // so the "Thinking…" state survives switching to another entry and back.

  prefs.get("tuningLogApiKeyBannerDismissed", function (dismissed) {
    apiKeyBannerDismissed = !!dismissed;
  });

  // Header / toolbar
  var nameElem = $(".tuning-log-name", dialog);
  var totalCostElem = $(".tuning-log-total-cost", dialog);
  var newBtn = $(".tuning-log-new", dialog);
  var openBtn = $(".tuning-log-open", dialog);
  var openInput = $(".tuning-log-open-input", dialog);
  var saveInput = $(".tuning-log-save-input", dialog);

  // Create-new form
  var createFormElem = $(".tuning-log-create-form", dialog);
  var nameInput = $(".tuning-log-name-input", dialog);
  var createCancelBtn = $(".tuning-log-create-cancel", dialog);
  var createConfirmBtn = $(".tuning-log-create-confirm", dialog);

  // Sidebar
  var emptyElem = $(".tuning-log-empty", dialog);
  var bodyElem = $(".tuning-log-body", dialog);
  var listElem = $(".tuning-log-entry-list", dialog);
  var prevBtn = $(".tuning-log-prev", dialog);
  var nextBtn = $(".tuning-log-next", dialog);

  // Main panel
  var titleElem = $(".tuning-log-entry-title", dialog);
  var toggleConfigBtn = $(".tuning-log-toggle-config", dialog);
  var expandImageBtn = $(".tuning-log-expand-image", dialog);
  var copyImageBtn = $(".tuning-log-copy-image", dialog);
  var copyPromptBtn = $(".tuning-log-copy-prompt", dialog);
  var noImageElem = $(".tuning-log-no-image", dialog);
  var imageElem = $(".tuning-log-image", dialog);
  var configElem = $(".tuning-log-config-summary", dialog);
  var notesBlockElem = $(".tuning-log-notes-block", dialog);
  var notesInput = $(".tuning-log-notes", dialog);

  // Ask AI panel
  var aiPanelElem = $(".tuning-log-ai-panel", dialog);
  var aiModelElem = $(".tuning-log-ai-model", dialog);
  var conversationElem = $(".tuning-log-ai-conversation", dialog);
  var noApiKeyBannerElem = $(".tuning-log-no-api-key-banner", dialog);
  var dismissApiKeyBannerBtn = $(".tuning-log-no-api-key-dismiss", dialog);
  var aiInputElem = $(".tuning-log-ai-input", dialog);
  var expertModeLabelElem = $(".tuning-log-ai-expert-mode-label", dialog);
  var expertModeCheckbox = $(".tuning-log-ai-expert-mode", dialog);
  var aiPromptInput = $(".tuning-log-ai-prompt", dialog);
  var askAiBtn = $(".tuning-log-ask-ai", dialog);
  var aiLoadingElem = $(".tuning-log-ai-loading", dialog);
  var aiErrorElem = $(".tuning-log-ai-error", dialog);

  var MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // Compares using UTC getters - see formatTimestamp for why.
  function isSameDay(a, b) {
    return (
      a.getUTCFullYear() === b.getUTCFullYear() &&
      a.getUTCMonth() === b.getUTCMonth() &&
      a.getUTCDate() === b.getUTCDate()
    );
  }

  /**
   * Entry timestamps are the flight log's own recorded start time (see TuningLog.logTimestamp),
   * always stamped in UTC. We want the digits shown here to match the "Log start datetime" the
   * user sees elsewhere (e.g. the header dialog) verbatim, rather than shifting them to the
   * viewer's local timezone - so this reads UTC components throughout instead of local ones.
   */
  function formatTimestamp(iso) {
    try {
      var d = new Date(iso);
      var time = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());

      var now = new Date();
      if (isSameDay(d, now)) {
        return "Today " + time;
      }

      var yesterday = new Date(now);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      if (isSameDay(d, yesterday)) {
        return "Yesterday " + time;
      }

      return (
        pad2(d.getUTCDate()) +
        " " +
        MONTH_NAMES[d.getUTCMonth()] +
        " " +
        d.getUTCFullYear() +
        " " +
        time
      );
    } catch (e) {
      return iso;
    }
  }

  function formatCost(usd) {
    if (!usd) return "";
    return "$" + usd.toFixed(usd < 1 ? 4 : 2);
  }

  // js/ai_models.json is the single source of truth for model ids/names/pricing.
  var MODELS_BY_ID = {};
  AI_MODELS.models.forEach(function (m) {
    MODELS_BY_ID[m.id] = m;
  });

  function modelDisplayName(id) {
    var model = id && MODELS_BY_ID[id];
    return (model && model.displayName) || id || "no model configured";
  }

  function entryCost(entry) {
    return (entry.ai && entry.ai.costUsd) || 0;
  }

  function excerpt(text, maxLen) {
    text = (text || "").trim();
    if (!text) return "";
    return text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
  }

  function currentEntry() {
    return selectedIndex === -1 ? null : currentLog.entries[selectedIndex];
  }

  function saveLogToDisk() {
    if (!currentLog || !currentPath) return;

    TuningLog.saveToPath(currentLog, currentPath, null, function (err) {
      alert("Could not save the tuning log file: " + err.message);
    });
  }

  /**
   * Index of the saved entry that corresponds to the flight log currently open in the main
   * viewer (matched by the log-derived id - see TuningLog.logTimestamp), or -1 if the open
   * flight log hasn't been captured into this tuning log yet.
   */
  function currentFlightLogEntryIndex() {
    var context = getContext() || {};
    if (!context.flightLog || !currentLog) return -1;

    var id = TuningLog.makeId(
      TuningLog.logTimestamp(context.flightLog.getSysConfig(), context.filePath),
    );

    for (var i = 0; i < currentLog.entries.length; i++) {
      if (currentLog.entries[i].id === id) return i;
    }

    return -1;
  }

  /**
   * The pinned "Current flight log" slot (selectedIndex === -1) is only shown/selectable when
   * there's nothing to point it at: no flight log open, or one that couldn't be captured. Once
   * it's been captured, the matching entry itself is the "current" one, so we show that single
   * entry instead of a duplicate placeholder row.
   */
  function pinnedSlotVisible() {
    return currentFlightLogEntryIndex() === -1;
  }

  function displayOrder() {
    var order = pinnedSlotVisible() ? [-1] : [];
    for (var i = currentLog.entries.length - 1; i >= 0; i--) order.push(i);
    return order;
  }

  function selectEntry(index) {
    selectedIndex = index;
    render();
  }

  function deleteEntry(index) {
    if (!confirm("Delete this tuning log entry? This cannot be undone."))
      return;

    currentLog.entries.splice(index, 1);
    selectedIndex = -1;
    saveLogToDisk();
    render();
  }

  // ---- Rendering ----

  function render() {
    var hasLog = !!currentLog;

    emptyElem.toggle(!hasLog && !creatingNew);
    createFormElem.toggle(creatingNew);
    // .toggle()/.show() would reset this to display:block (jQuery doesn't know it needs
    // to be a flex row to lay the sidebar and main panel out side by side), so set the
    // CSS display value explicitly instead.
    bodyElem.css("display", hasLog && !creatingNew ? "flex" : "none");

    nameElem.text(hasLog ? currentLog.name : "");

    if (!hasLog) {
      totalCostElem.text("");
      return;
    }

    var totalCost = 0;
    for (var i = 0; i < currentLog.entries.length; i++) {
      totalCost += entryCost(currentLog.entries[i]);
    }
    totalCostElem.text(totalCost ? "Total: " + formatCost(totalCost) : "");

    renderSidebar();
    renderMain();
  }

  function renderSidebar() {
    listElem.empty();

    var context = getContext() || {};

    if (pinnedSlotVisible()) {
      var currentLi = $('<li class="ai-session-entry current"></li>')
        .toggleClass("active", selectedIndex === -1)
        .append(
          $('<span class="ai-session-entry-label"></span>').text(
            "Current flight log",
          ),
        )
        .append($("<br>"))
        .append(
          $("<small></small>").text(
            context.flightLog
              ? "Step response unavailable"
              : "No flight log open",
          ),
        );
      currentLi.on("click", function () {
        selectEntry(-1);
      });
      listElem.append(currentLi);
    }

    var currentEntryIndex = currentFlightLogEntryIndex();
    var entries = currentLog.entries;
    for (var i = entries.length - 1; i >= 0; i--) {
      listElem.append(
        buildEntryListItem(entries[i], i, i === currentEntryIndex),
      );
    }
  }

  function buildEntryListItem(entry, index, isCurrent) {
    var subtitle = isCurrent ? formatTimestamp(entry.timestamp) : "Read-only";
    var cost = entryCost(entry);
    if (cost) subtitle += "  ·  " + formatCost(cost);

    var li = $('<li class="ai-session-entry"></li>')
      .toggleClass("active", selectedIndex === index)
      .toggleClass("current", isCurrent)
      .toggleClass("readonly", !isCurrent)
      .append(
        $('<span class="ai-session-entry-label"></span>').text(
          isCurrent ? "Current" : formatTimestamp(entry.timestamp),
        ),
      )
      .append($("<br>"))
      .append($("<small></small>").text(subtitle));

    var deleteBtn = $(
      '<button type="button" class="ai-session-entry-delete" title="Delete entry">&times;</button>',
    );
    deleteBtn.on("click", function (e) {
      e.stopPropagation();
      deleteEntry(index);
    });
    li.append(deleteBtn);

    li.on("click", function () {
      selectEntry(index);
    });

    return li;
  }

  function renderMain() {
    var entry = currentEntry();
    var context = getContext() || {};
    var isCurrentFlightLog =
      selectedIndex === -1 || selectedIndex === currentFlightLogEntryIndex();
    var hasImage = !!(entry && entry.image);
    var hasConfig = !!(entry && entry.config);
    var hasConversation = !!(
      entry &&
      entry.ai &&
      entry.ai.conversation &&
      entry.ai.conversation.length
    );
    // Whether this entry has an Ask AI request in flight right now, wherever it was started
    // from - checked up front so it can keep the panel/spinner visible even if this entry no
    // longer matches "the currently open flight log" by the time the response comes back.
    var isPending = !!(entry && pendingEntryIds[entry.id]);

    titleElem.text(
      selectedIndex === -1
        ? "Current flight log"
        : isCurrentFlightLog
          ? "Current flight log — " + formatTimestamp(entry.timestamp)
          : formatTimestamp(entry.timestamp),
    );

    toggleConfigBtn
      .toggle(hasConfig)
      .text(configVisible ? "Hide config" : "Expand config");
    expandImageBtn
      .toggle(hasImage)
      .text(imageExpanded ? "Shrink image" : "Expand image");
    copyImageBtn.toggle(hasImage);
    copyPromptBtn.toggle(hasImage && isCurrentFlightLog);

    noImageElem.toggle(!hasImage);
    if (!hasImage) {
      noImageElem.text(
        context.flightLog
          ? "The step response panel is not available for this flight log."
          : "No flight log is currently open.",
      );
    }
    imageElem
      .toggle(hasImage)
      .toggleClass("expanded", imageExpanded)
      .attr("src", (entry && entry.image) || "");

    configElem
      .toggle(hasConfig && configVisible)
      .text((entry && entry.config) || "");

    // Past entries are read-only, so there's no point showing an empty notes box for them -
    // only hide it when there's nothing to read. The current entry always shows it, since
    // that's where the user would type new notes in.
    notesBlockElem.toggle(!!entry && (isCurrentFlightLog || !!entry.notes));
    notesInput.val((entry && entry.notes) || "");
    notesInput.prop("readonly", !isCurrentFlightLog);

    // Asking is only offered on the entry for the currently open flight log - it doesn't make
    // sense to start a new AI conversation about a past entry. A past conversation is still
    // shown (read-only) if that entry already has one.
    var canAsk = hasImage && isCurrentFlightLog;
    var hasApiKey = !!(context.userSettings || {}).aiApiKey;

    aiPanelElem.toggle(
      hasImage && (isCurrentFlightLog || hasConversation || isPending),
    );
    aiInputElem.toggle(canAsk && hasApiKey);
    // Expert mode only affects the initial analysis prompt, not follow-up questions, so hide
    // it once a conversation is already underway.
    expertModeLabelElem.toggle(canAsk && hasApiKey && !hasConversation);
    noApiKeyBannerElem.toggle(canAsk && !hasApiKey && !apiKeyBannerDismissed);
    // Once a conversation exists, keep showing the model that actually answered it, even
    // if Settings has since been changed to a different model.
    var usedModel = entry && entry.ai && entry.ai.model;
    var settingsModel = (context.userSettings || {}).aiModel;
    aiModelElem.text(
      (hasConversation ? "Model: " : "Will use: ") +
        modelDisplayName(usedModel || settingsModel),
    );
    aiPromptInput.attr(
      "placeholder",
      hasConversation
        ? "Ask a follow-up question…"
        : "Anything specific you want help with? (optional)",
    );

    aiErrorElem.hide();
    aiLoadingElem.toggle(isPending);
    askAiBtn.prop("disabled", isPending);

    renderConversation(entry);
  }

  function renderConversation(entry) {
    conversationElem.empty();

    var conversation = (entry && entry.ai && entry.ai.conversation) || [];

    for (var i = 0; i < conversation.length; i++) {
      var turn = conversation[i];

      if (turn.role === "user") {
        if (typeof turn.content !== "string") continue; // the initial image+prompt turn - already shown above
        conversationElem.append(
          $('<div class="ai-analysis-turn ai-analysis-turn-user"></div>').text(
            turn.content,
          ),
        );
      } else {
        conversationElem.append(
          $('<div class="ai-analysis-turn ai-analysis-result"></div>').html(
            marked.parse(String(turn.content)),
          ),
        );
      }
    }
  }

  /**
   * Captures a step response image + config summary from whatever flight log is currently open
   * in the main viewer, or returns null if there's nothing to capture.
   */
  function captureFromContext() {
    var context = getContext() || {};
    if (!context.flightLog || !context.graph) return null;

    var stepResponse = context.graph.getStepResponse();
    if (!stepResponse) return null;

    stepResponse.plot();
    var sysConfig = context.flightLog.getSysConfig();

    return {
      image: stepResponse.captureImage(),
      config: TuningLog.buildConfigSummary(sysConfig),
      notes: "",
      craftName: sysConfig["Craft name"] || "",
      timestamp: TuningLog.logTimestamp(sysConfig, context.filePath),
    };
  }

  /**
   * Adds an entry for the currently open flight log if it isn't already in the log - there's no
   * manual "Capture" step, this just runs whenever the dialog needs to be in sync (opening it,
   * creating/loading a log). Returns true if it actually captured something new, so callers can
   * decide whether to jump the selection to it.
   */
  function ensureCurrentFlightLogCaptured() {
    if (!currentLog || currentFlightLogEntryIndex() !== -1) return false;

    var capture = captureFromContext();
    if (!capture) return false;

    TuningLog.addEntry(currentLog, capture);
    saveLogToDisk();

    return true;
  }

  // ---- New / Open ----

  newBtn.click(function (e) {
    e.preventDefault();

    var context = getContext() || {};
    nameInput.val(
      (context.flightLog && context.flightLog.getSysConfig()["Craft name"]) ||
        "",
    );
    creatingNew = true;
    render();
  });

  createCancelBtn.click(function (e) {
    e.preventDefault();
    creatingNew = false;
    render();
  });

  createConfirmBtn.click(function (e) {
    e.preventDefault();

    var name = (nameInput.val() || "").trim();
    if (!name) {
      alert("Please enter a name for the tuning log.");
      return;
    }

    var context = getContext() || {};
    var craftName =
      (context.flightLog && context.flightLog.getSysConfig()["Craft name"]) ||
      "";
    var log = TuningLog.create(name, craftName);

    saveInput.attr("nwsaveas", TuningLog.buildFilename(log));
    saveInput.off("change").one("change", function () {
      var path = $(this).val();
      $(this).val("");
      if (!path) return;

      var capture = captureFromContext();
      if (capture) {
        TuningLog.addEntry(log, capture);
      }

      TuningLog.saveToPath(
        log,
        path,
        function () {
          currentLog = log;
          currentPath = path;
          selectedIndex = capture ? 0 : -1;
          creatingNew = false;

          prefs.set("tuningLogLastPath", path);
          render();
        },
        function (err) {
          alert("Could not create the tuning log file: " + err.message);
        },
      );
    });
    saveInput[0].click();
  });

  openBtn.click(function (e) {
    e.preventDefault();
    openInput[0].click();
  });

  openInput.change(function () {
    var file = this.files && this.files[0];
    $(this).val("");
    if (!file) return;

    loadFromPath(file.path);
  });

  /**
   * silent - true when this is an automatic reload (e.g. the remembered last-used path on
   * dialog open) rather than something the user explicitly asked for, so a failure shouldn't
   * pop up an alert - it just forgets the stale path and falls back to the empty state.
   */
  function loadFromPath(path, silent) {
    TuningLog.loadFromPath(
      path,
      function (log) {
        currentLog = log;
        currentPath = path;
        creatingNew = false;
        selectedIndex = -1;

        if (ensureCurrentFlightLogCaptured()) {
          selectedIndex = currentFlightLogEntryIndex();
        }

        prefs.set("tuningLogLastPath", path);
        render();
      },
      function (err) {
        if (silent) {
          prefs.set("tuningLogLastPath", null);
        } else {
          alert("Could not open the tuning log file: " + err.message);
        }
        render(); // fall back to whatever was showing before (the empty state, if nothing was)
      },
    );
  }

  // ---- Flicking through entries ----

  prevBtn.click(function (e) {
    e.preventDefault();
    step(-1);
  });

  nextBtn.click(function (e) {
    e.preventDefault();
    step(1);
  });

  function step(dir) {
    if (!currentLog) return;

    var order = displayOrder();
    var pos = order.indexOf(selectedIndex);
    var newPos = pos + dir;

    if (newPos < 0 || newPos >= order.length) return;

    selectEntry(order[newPos]);
  }

  // ---- Notes ----

  notesInput.on("change", function () {
    var entry = currentEntry();
    if (!entry) return;

    entry.notes = notesInput.val();
    saveLogToDisk();
  });

  // ---- Config toggle / copy buttons ----

  function copyImageToClipboard(imageDataUrl) {
    try {
      // With raw left false (the default), NW.js expects the full "data:image/png;base64,..."
      // URI as-is - captureImage() already returns exactly that.
      require("nw.gui").Clipboard.get().set(imageDataUrl, "png");
    } catch (e) {
      alert("Could not copy the image: " + e.message);
    }
  }

  function copyTextToClipboard(text) {
    try {
      require("nw.gui").Clipboard.get().set(text, "text");
    } catch (e) {
      alert("Could not copy: " + e.message);
    }
  }

  toggleConfigBtn.click(function (e) {
    e.preventDefault();
    configVisible = !configVisible;
    renderMain();
  });

  expandImageBtn.click(function (e) {
    e.preventDefault();
    imageExpanded = !imageExpanded;
    renderMain();
  });

  copyImageBtn.click(function (e) {
    e.preventDefault();

    var entry = currentEntry();
    if (!entry || !entry.image) return;

    copyImageToClipboard(entry.image);
  });

  copyPromptBtn.click(function (e) {
    e.preventDefault();

    var entry = currentEntry();
    if (!entry) return;

    copyTextToClipboard(
      TuningAI.buildPromptText({
        configSummary: entry.config,
        instructions: aiPromptInput.val(),
        expertMode: expertModeCheckbox.is(":checked"),
      }),
    );
  });

  // ---- Ask AI ----

  prefs.get("tuningLogAiExpertMode", function (expertMode) {
    expertModeCheckbox.prop("checked", !!expertMode);
  });

  expertModeCheckbox.change(function () {
    prefs.set("tuningLogAiExpertMode", expertModeCheckbox.is(":checked"));
  });

  dismissApiKeyBannerBtn.click(function (e) {
    e.preventDefault();
    apiKeyBannerDismissed = true;
    prefs.set("tuningLogApiKeyBannerDismissed", true);
    renderMain();
  });

  askAiBtn.click(function (e) {
    e.preventDefault();

    var entry = currentEntry();
    if (!entry || !entry.image) return;

    var context = getContext() || {};
    var settings = context.userSettings || {};
    var promptText = aiPromptInput.val();

    // Keyed by entry id (not just the currently-viewed entry) so the "Thinking…" state is
    // still there if the user switches to a different entry and comes back to this one.
    pendingEntryIds[entry.id] = true;
    renderMain();

    var hasConversation = !!(
      entry.ai &&
      entry.ai.conversation &&
      entry.ai.conversation.length
    );
    var historyMessages = TuningAI.buildHistoryMessages(currentLog, entry.id);

    var callOptions = {
      apiKey: settings.aiApiKey,
      model: settings.aiModel,
      historyMessages: historyMessages,
      expertMode: expertModeCheckbox.is(":checked"),
    };

    function onResult(text, entryMessages, costUsd) {
      delete pendingEntryIds[entry.id];

      entry.ai = entry.ai || {};
      entry.ai.model = settings.aiModel;
      entry.ai.conversation = entryMessages;
      entry.ai.costUsd = (entry.ai.costUsd || 0) + (costUsd || 0);

      saveLogToDisk();

      // aiPromptInput is a single shared textarea, not per-entry - only worth clearing it if
      // we're still looking at the entry this response belongs to.
      if (currentEntry() === entry) {
        aiPromptInput.val("");
      }

      // Full re-render (not just the conversation) so the cost badge on this entry's
      // sidebar row and the total-cost figure in the header pick up the new spend.
      render();
    }

    function onError(message) {
      delete pendingEntryIds[entry.id];
      render();

      // Only worth surfacing the error inline if we're still looking at the entry it belongs
      // to - if the user has since switched entries, the pending indicator just quietly clears.
      if (currentEntry() === entry) {
        aiErrorElem.text(message).show();
      }
    }

    if (hasConversation) {
      callOptions.messages = entry.ai.conversation;
      callOptions.question = promptText;
      TuningAI.ask(callOptions, onResult, onError);
    } else {
      callOptions.entry = entry;
      callOptions.instructions = promptText;
      TuningAI.analyze(callOptions, onResult, onError);
    }
  });

  // ---- Entry point ----

  this.show = function () {
    if (!currentLog) {
      prefs.get("tuningLogLastPath", function (path) {
        if (path) {
          loadFromPath(path, true);
        } else {
          render();
        }
      });
    } else {
      // The dialog may have been closed and reopened after a different flight log was
      // loaded in the main viewer - make sure it's captured before rendering.
      if (ensureCurrentFlightLogCaptured()) {
        selectedIndex = currentFlightLogEntryIndex();
      }
      render();
    }

    dialog.modal("show");
  };
}
