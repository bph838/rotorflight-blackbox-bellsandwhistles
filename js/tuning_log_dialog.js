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

    var marked = require('marked');
    var prefs = new PrefStorage();

    var currentLog = null,
        currentPath = null,
        selectedIndex = -1, // -1 = the "current flight log" placeholder; otherwise an index into currentLog.entries
        creatingNew = false;

    // Header / toolbar
    var nameElem            = $(".tuning-log-name", dialog);
    var newBtn               = $(".tuning-log-new", dialog);
    var openBtn               = $(".tuning-log-open", dialog);
    var openInput              = $(".tuning-log-open-input", dialog);
    var saveInput                = $(".tuning-log-save-input", dialog);

    // Create-new form
    var createFormElem            = $(".tuning-log-create-form", dialog);
    var nameInput                   = $(".tuning-log-name-input", dialog);
    var createCancelBtn               = $(".tuning-log-create-cancel", dialog);
    var createConfirmBtn                = $(".tuning-log-create-confirm", dialog);

    // Sidebar
    var emptyElem            = $(".tuning-log-empty", dialog);
    var bodyElem               = $(".tuning-log-body", dialog);
    var listElem                 = $(".tuning-log-entry-list", dialog);
    var prevBtn                    = $(".tuning-log-prev", dialog);
    var nextBtn                      = $(".tuning-log-next", dialog);

    // Main panel
    var titleElem             = $(".tuning-log-entry-title", dialog);
    var noImageElem               = $(".tuning-log-no-image", dialog);
    var imageElem                   = $(".tuning-log-image", dialog);
    var configElem                    = $(".tuning-log-config-summary", dialog);
    var notesBlockElem                  = $(".tuning-log-notes-block", dialog);
    var notesInput                        = $(".tuning-log-notes", dialog);

    // Ask AI panel
    var aiPanelElem            = $(".tuning-log-ai-panel", dialog);
    var conversationElem         = $(".tuning-log-ai-conversation", dialog);
    var aiInputElem                = $(".tuning-log-ai-input", dialog);
    var aiPromptInput              = $(".tuning-log-ai-prompt", dialog);
    var askAiBtn                     = $(".tuning-log-ask-ai", dialog);
    var aiLoadingElem                  = $(".tuning-log-ai-loading", dialog);
    var aiErrorElem                     = $(".tuning-log-ai-error", dialog);

    function isSameDay(a, b) {
        return a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

    function formatTimestamp(iso) {
        try {
            var d = new Date(iso);
            var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            var now = new Date();
            if (isSameDay(d, now)) {
                return 'Today ' + time;
            }

            var yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            if (isSameDay(d, yesterday)) {
                return 'Yesterday ' + time;
            }

            return d.toLocaleString();
        } catch (e) {
            return iso;
        }
    }

    function excerpt(text, maxLen) {
        text = (text || '').trim();
        if (!text) return '';
        return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
    }

    function currentEntry() {
        return selectedIndex === -1 ? null : currentLog.entries[selectedIndex];
    }

    function saveLogToDisk() {
        if (!currentLog || !currentPath) return;

        TuningLog.saveToPath(currentLog, currentPath, null, function(err) {
            alert('Could not save the tuning log file: ' + err.message);
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

        var id = TuningLog.makeId(TuningLog.logTimestamp(context.flightLog.getSysConfig()));

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
        if (!confirm('Delete this tuning log entry? This cannot be undone.')) return;

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
        bodyElem.css('display', (hasLog && !creatingNew) ? 'flex' : 'none');

        nameElem.text(hasLog ? currentLog.name : '');

        if (!hasLog) return;

        renderSidebar();
        renderMain();
    }

    function renderSidebar() {
        listElem.empty();

        var context = getContext() || {};

        if (pinnedSlotVisible()) {
            var currentLi = $('<li class="ai-session-entry"></li>')
                .toggleClass('active', selectedIndex === -1)
                .append($('<span class="ai-session-entry-label"></span>').text('Current flight log'))
                .append($('<br>'))
                .append($('<small></small>').text(
                    context.flightLog ? 'Step response unavailable' : 'No flight log open'));
            currentLi.on('click', function() { selectEntry(-1); });
            listElem.append(currentLi);
        }

        var currentEntryIndex = currentFlightLogEntryIndex();
        var entries = currentLog.entries;
        for (var i = entries.length - 1; i >= 0; i--) {
            listElem.append(buildEntryListItem(entries[i], i, i === currentEntryIndex));
        }
    }

    function buildEntryListItem(entry, index, isCurrent) {
        var li = $('<li class="ai-session-entry"></li>')
            .toggleClass('active', selectedIndex === index)
            .append($('<span class="ai-session-entry-label"></span>').text(isCurrent ? 'Current' : formatTimestamp(entry.timestamp)))
            .append($('<br>'))
            .append($('<small></small>').text(isCurrent ? formatTimestamp(entry.timestamp) : (excerpt(entry.notes, 60) || '(no notes)')));

        var deleteBtn = $('<button type="button" class="ai-session-entry-delete" title="Delete entry">&times;</button>');
        deleteBtn.on('click', function(e) {
            e.stopPropagation();
            deleteEntry(index);
        });
        li.append(deleteBtn);

        li.on('click', function() { selectEntry(index); });

        return li;
    }

    function renderMain() {
        var entry = currentEntry();
        var context = getContext() || {};
        var isCurrentFlightLog = selectedIndex === -1 || selectedIndex === currentFlightLogEntryIndex();

        titleElem.text(
            selectedIndex === -1 ? 'Current flight log' :
            isCurrentFlightLog ? 'Current flight log — ' + formatTimestamp(entry.timestamp) :
            formatTimestamp(entry.timestamp));

        noImageElem.toggle(!entry || !entry.image);
        if (!entry || !entry.image) {
            noImageElem.text(context.flightLog ? 'The step response panel is not available for this flight log.' : 'No flight log is currently open.');
        }
        imageElem.toggle(!!(entry && entry.image)).attr('src', (entry && entry.image) || '');

        configElem.toggle(!!(entry && entry.config)).text((entry && entry.config) || '');

        notesBlockElem.toggle(!!entry);
        notesInput.val((entry && entry.notes) || '');
        notesInput.prop('readonly', !isCurrentFlightLog);

        var hasImage = !!(entry && entry.image);
        var hasConversation = !!(entry && entry.ai && entry.ai.conversation && entry.ai.conversation.length);

        // Asking is only offered on the entry for the currently open flight log - it doesn't make
        // sense to start a new AI conversation about a past entry. A past conversation is still
        // shown (read-only) if that entry already has one.
        aiPanelElem.toggle(hasImage && (isCurrentFlightLog || hasConversation));
        aiInputElem.toggle(hasImage && isCurrentFlightLog);
        aiPromptInput.attr('placeholder', hasConversation ?
            'Ask a follow-up question…' : 'Anything specific you want help with? (optional)');
        aiErrorElem.hide();
        aiLoadingElem.hide();
        askAiBtn.prop('disabled', false);

        renderConversation(entry);
    }

    function renderConversation(entry) {
        conversationElem.empty();

        var conversation = (entry && entry.ai && entry.ai.conversation) || [];

        for (var i = 0; i < conversation.length; i++) {
            var turn = conversation[i];

            if (turn.role === 'user') {
                if (typeof turn.content !== 'string') continue; // the initial image+prompt turn - already shown above
                conversationElem.append($('<div class="ai-analysis-turn ai-analysis-turn-user"></div>').text(turn.content));
            } else {
                conversationElem.append($('<div class="ai-analysis-turn ai-analysis-result"></div>').html(marked.parse(String(turn.content))));
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
            notes: '',
            craftName: sysConfig['Craft name'] || '',
            timestamp: TuningLog.logTimestamp(sysConfig),
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

    newBtn.click(function(e) {
        e.preventDefault();

        var context = getContext() || {};
        nameInput.val((context.flightLog && context.flightLog.getSysConfig()['Craft name']) || '');
        creatingNew = true;
        render();
    });

    createCancelBtn.click(function(e) {
        e.preventDefault();
        creatingNew = false;
        render();
    });

    createConfirmBtn.click(function(e) {
        e.preventDefault();

        var name = (nameInput.val() || '').trim();
        if (!name) {
            alert('Please enter a name for the tuning log.');
            return;
        }

        var context = getContext() || {};
        var craftName = (context.flightLog && context.flightLog.getSysConfig()['Craft name']) || '';
        var log = TuningLog.create(name, craftName);

        saveInput.attr('nwsaveas', TuningLog.buildFilename(log));
        saveInput.off('change').one('change', function() {
            var path = $(this).val();
            $(this).val('');
            if (!path) return;

            var capture = captureFromContext();
            if (capture) {
                TuningLog.addEntry(log, capture);
            }

            TuningLog.saveToPath(log, path, function() {
                currentLog = log;
                currentPath = path;
                selectedIndex = capture ? 0 : -1;
                creatingNew = false;

                prefs.set('tuningLogLastPath', path);
                render();
            }, function(err) {
                alert('Could not create the tuning log file: ' + err.message);
            });
        });
        saveInput[0].click();
    });

    openBtn.click(function(e) {
        e.preventDefault();
        openInput[0].click();
    });

    openInput.change(function() {
        var file = this.files && this.files[0];
        $(this).val('');
        if (!file) return;

        loadFromPath(file.path);
    });

    /**
     * silent - true when this is an automatic reload (e.g. the remembered last-used path on
     * dialog open) rather than something the user explicitly asked for, so a failure shouldn't
     * pop up an alert - it just forgets the stale path and falls back to the empty state.
     */
    function loadFromPath(path, silent) {
        TuningLog.loadFromPath(path, function(log) {
            currentLog = log;
            currentPath = path;
            creatingNew = false;
            selectedIndex = -1;

            if (ensureCurrentFlightLogCaptured()) {
                selectedIndex = currentFlightLogEntryIndex();
            }

            prefs.set('tuningLogLastPath', path);
            render();
        }, function(err) {
            if (silent) {
                prefs.set('tuningLogLastPath', null);
            } else {
                alert('Could not open the tuning log file: ' + err.message);
            }
            render(); // fall back to whatever was showing before (the empty state, if nothing was)
        });
    }

    // ---- Flicking through entries ----

    prevBtn.click(function(e) {
        e.preventDefault();
        step(-1);
    });

    nextBtn.click(function(e) {
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

    notesInput.on('change', function() {
        var entry = currentEntry();
        if (!entry) return;

        entry.notes = notesInput.val();
        saveLogToDisk();
    });

    // ---- Ask AI ----

    askAiBtn.click(function(e) {
        e.preventDefault();

        var entry = currentEntry();
        if (!entry || !entry.image) return;

        var context = getContext() || {};
        var settings = context.userSettings || {};
        var promptText = aiPromptInput.val();

        aiErrorElem.hide();
        aiLoadingElem.show();
        askAiBtn.prop('disabled', true);

        var hasConversation = !!(entry.ai && entry.ai.conversation && entry.ai.conversation.length);
        var historyMessages = TuningAI.buildHistoryMessages(currentLog, entry.id);

        var callOptions = {
            apiKey: settings.aiApiKey,
            model: settings.aiModel,
            historyMessages: historyMessages,
        };

        function onResult(text, entryMessages) {
            entry.ai = entry.ai || {};
            entry.ai.model = settings.aiModel;
            entry.ai.conversation = entryMessages;

            saveLogToDisk();

            aiPromptInput.val('');
            aiLoadingElem.hide();
            askAiBtn.prop('disabled', false);
            renderConversation(entry);
            aiPromptInput.attr('placeholder', 'Ask a follow-up question…');
        }

        function onError(message) {
            aiLoadingElem.hide();
            askAiBtn.prop('disabled', false);
            aiErrorElem.text(message).show();
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

    this.show = function() {
        if (!currentLog) {
            prefs.get('tuningLogLastPath', function(path) {
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

        dialog.modal('show');
    };
}
