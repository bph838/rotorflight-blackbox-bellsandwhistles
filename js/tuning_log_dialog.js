"use strict";

/**
 * Dialog controller for the Tuning Log: create/open a TuningLog JSON file, capture step response
 * entries from the currently loaded flight log, flick through past entries, and ask the AI for
 * tuning advice on the current entry (with the rest of the log sent along as history).
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
        selectedIndex = -1, // -1 = the "current flight log" slot; otherwise an index into currentLog.entries
        draftEntry = null,  // in-memory, not-yet-saved capture shown while selectedIndex === -1
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
    var captureBtn              = $(".tuning-log-capture", dialog);
    var noImageElem               = $(".tuning-log-no-image", dialog);
    var imageElem                   = $(".tuning-log-image", dialog);
    var configElem                    = $(".tuning-log-config-summary", dialog);
    var notesBlockElem                  = $(".tuning-log-notes-block", dialog);
    var notesInput                        = $(".tuning-log-notes", dialog);
    var saveRowElem                         = $(".tuning-log-save-row", dialog);
    var saveEntryBtn                          = $(".tuning-log-save-entry", dialog);

    // Ask AI panel
    var aiPanelElem            = $(".tuning-log-ai-panel", dialog);
    var conversationElem         = $(".tuning-log-ai-conversation", dialog);
    var aiPromptInput              = $(".tuning-log-ai-prompt", dialog);
    var askAiBtn                     = $(".tuning-log-ask-ai", dialog);
    var aiLoadingElem                  = $(".tuning-log-ai-loading", dialog);
    var aiErrorElem                     = $(".tuning-log-ai-error", dialog);

    function formatTimestamp(iso) {
        try {
            return new Date(iso).toLocaleString();
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
        return selectedIndex === -1 ? draftEntry : currentLog.entries[selectedIndex];
    }

    function isSelectionSaved() {
        return selectedIndex !== -1;
    }

    function saveLogToDisk() {
        if (!currentLog || !currentPath) return;

        TuningLog.saveToPath(currentLog, currentPath, null, function(err) {
            alert('Could not save the tuning log file: ' + err.message);
        });
    }

    function maybeDiscardDraft() {
        if (draftEntry && draftEntry.image) {
            return confirm('You have an unsaved captured entry. Switching tuning logs will discard it. Continue?');
        }
        return true;
    }

    function displayOrder() {
        var order = [-1];
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
        bodyElem.toggle(hasLog && !creatingNew);

        nameElem.text(hasLog ? currentLog.name : '');

        if (!hasLog) return;

        renderSidebar();
        renderMain();
    }

    function renderSidebar() {
        listElem.empty();

        var context = getContext() || {};

        var currentLi = $('<li class="ai-session-entry"></li>')
            .toggleClass('active', selectedIndex === -1)
            .append($('<span class="ai-session-entry-label"></span>').text('Current flight log'))
            .append($('<br>'))
            .append($('<small></small>').text(
                draftEntry ? 'Unsaved capture' :
                context.flightLog ? 'Capture a step response →' : 'No flight log open'));
        currentLi.on('click', function() { selectEntry(-1); });
        listElem.append(currentLi);

        var entries = currentLog.entries;
        for (var i = entries.length - 1; i >= 0; i--) {
            listElem.append(buildEntryListItem(entries[i], i));
        }
    }

    function buildEntryListItem(entry, index) {
        var li = $('<li class="ai-session-entry"></li>')
            .toggleClass('active', selectedIndex === index)
            .append($('<span class="ai-session-entry-label"></span>').text(formatTimestamp(entry.timestamp)))
            .append($('<br>'))
            .append($('<small></small>').text(excerpt(entry.notes, 60) || '(no notes)'));

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
        var saved = isSelectionSaved();

        titleElem.text(selectedIndex === -1 ? 'Current flight log' : formatTimestamp(entry.timestamp));

        captureBtn.toggle(selectedIndex === -1 && !!context.flightLog && !!context.graph);

        noImageElem.toggle(!entry || !entry.image);
        imageElem.toggle(!!(entry && entry.image)).attr('src', (entry && entry.image) || '');

        configElem.toggle(!!(entry && entry.config)).text((entry && entry.config) || '');

        notesBlockElem.toggle(!!entry);
        notesInput.val((entry && entry.notes) || '');

        saveRowElem.toggle(selectedIndex === -1 && !!draftEntry && !!draftEntry.image);

        aiPanelElem.toggle(!!(entry && entry.image));
        aiPromptInput.attr('placeholder', (entry && entry.ai && entry.ai.conversation && entry.ai.conversation.length) ?
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

    // ---- New / Open ----

    newBtn.click(function(e) {
        e.preventDefault();
        if (!maybeDiscardDraft()) return;

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

            TuningLog.saveToPath(log, path, function() {
                currentLog = log;
                currentPath = path;
                selectedIndex = -1;
                draftEntry = null;
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
        if (!maybeDiscardDraft()) return;
        openInput[0].click();
    });

    openInput.change(function() {
        var file = this.files && this.files[0];
        $(this).val('');
        if (!file) return;

        loadFromPath(file.path);
    });

    function loadFromPath(path) {
        TuningLog.loadFromPath(path, function(log) {
            currentLog = log;
            currentPath = path;
            selectedIndex = -1;
            draftEntry = null;
            creatingNew = false;

            prefs.set('tuningLogLastPath', path);
            render();
        }, function(err) {
            alert('Could not open the tuning log file: ' + err.message);
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

    // ---- Capture / save / notes ----

    captureBtn.click(function(e) {
        e.preventDefault();

        var context = getContext() || {};
        if (!context.flightLog || !context.graph) return;

        if (draftEntry && draftEntry.image && !confirm('Replace the current unsaved capture with a new one?')) return;

        var stepResponse = context.graph.getStepResponse();
        if (!stepResponse) {
            alert('The step response panel is not available for this flight log.');
            return;
        }

        stepResponse.plot();
        var image = stepResponse.captureImage();
        var sysConfig = context.flightLog.getSysConfig();

        draftEntry = {
            image: image,
            config: TuningLog.buildConfigSummary(sysConfig),
            notes: '',
            craftName: sysConfig['Craft name'] || '',
        };

        selectedIndex = -1;
        render();
    });

    notesInput.on('change', function() {
        var entry = currentEntry();
        if (!entry) return;

        entry.notes = notesInput.val();

        if (isSelectionSaved()) {
            saveLogToDisk();
        }
    });

    saveEntryBtn.click(function(e) {
        e.preventDefault();
        if (!draftEntry || !draftEntry.image || !currentLog) return;

        draftEntry.notes = notesInput.val();

        TuningLog.addEntry(currentLog, draftEntry);
        saveLogToDisk();

        selectedIndex = currentLog.entries.length - 1;
        draftEntry = null;

        render();
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
        var historyMessages = TuningAI.buildHistoryMessages(currentLog, isSelectionSaved() ? entry.id : null);

        var callOptions = {
            apiKey: settings.aiApiKey,
            model: settings.aiModel,
            historyMessages: historyMessages,
        };

        function onResult(text, entryMessages) {
            entry.ai = entry.ai || {};
            entry.ai.model = settings.aiModel;
            entry.ai.conversation = entryMessages;

            if (selectedIndex === -1) {
                draftEntry.ai = entry.ai;
            } else {
                saveLogToDisk();
            }

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
                    TuningLog.loadFromPath(path, function(log) {
                        currentLog = log;
                        currentPath = path;
                        render();
                    }, function() {
                        render(); // remembered file is gone/unreadable - fall back to the empty state
                    });
                } else {
                    render();
                }
            });
        } else {
            render();
        }

        dialog.modal('show');
    };
}
