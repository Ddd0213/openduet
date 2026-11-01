// The ShellActions the UI calls (App/ShellContract.swift, App/TasksContract.swift). Menu,
// OpenDuet sheet, profile and usage arrive in M4; until then they are only logged. In-app routes
// open tasks (duet://tasks/<id>); other duet:// links are M4+.
import Foundation

extension ChatStore {
    var actions: ShellActions {
        var actions = ShellActions()
        actions.send = { [weak self] text, ids in self?.send(text: text, attachmentIds: ids) }
        actions.setReplyTo = { [weak self] quote in self?.composer.replyTo = quote }
        actions.addAttachments = { [weak self] files in self?.addAttachments(files) }
        actions.removeAttachment = { [weak self] id in self?.removeAttachment(id) }
        actions.retryAttachment = { [weak self] id in self?.retryAttachment(id) }
        actions.retryPending = { [weak self] clientId in self?.retryPending(clientId) }
        actions.reloadThread = { [weak self] in self?.loadThread() }
        actions.loadOlder = { [weak self] in self?.loadOlder() }
        actions.quickReply = { [weak self] messageId, option in self?.quickReply(messageId: messageId, option: option) }
        actions.markRead = { [weak self] in self?.markRead() }
        actions.openRoute = { [weak self] url in self?.openRoute(url) }
        actions.focusShown = { [weak self] token in self?.routeFocusShown(token) }
        // The UI slides the menu in itself and calls menu.refresh.
        actions.openMenu = {}
        actions.openAssistant = { [weak self] in self?.present(.assistant) }
        actions.openProfile = { [weak self] in self?.present(.profile) }
        actions.openUsage = { [weak self] in self?.present(.usage) }
        actions.openModels = { [weak self] in self?.present(.models) }
        actions.openVoice = { [weak self] in self?.present(.voice) }
        // The Tasks tab refreshes itself when it appears; the store only keeps the tab for the
        // notification rules and for routes.
        actions.tabChanged = { [weak self] tab in
            guard let self, self.tab != tab else { return }
            self.tab = tab
        }
        actions.tasks = taskActions
        actions.cards = cardActions
        actions.menu = menuActions
        actions.connectors = connectorActions
        actions.account = accountActions
        // M6: ChatStore+Computer (computer, files) and ChatStore+Make (Make, chat extras).
        actions.computer = computerActions
        actions.files = fileActions
        actions.make = makeActions
        actions.chatExtras = chatExtrasActions
        // M10: ■ stop responding (ChatStore+Stop.swift)
        actions.stop = { [weak self] in self?.stopReply() }
        actions.stopTask = { [weak self] in self?.stopTaskReply() }
        // M11: a connection card's Connect (ChatStore+Channels.swift)
        actions.submitConnection = { [weak self] id, body in self?.submitConnection(messageId: id, body) }
        return actions
    }

    private var menuActions: MenuActions {
        var menu = MenuActions()
        menu.refresh = { [weak self] in self?.refreshMenu() }
        menu.select = { [weak self] id in self?.selectChannel(id) }
        menu.loadArchived = { [weak self] in self?.loadArchived() }
        menu.create = { [weak self] name, purpose, icon, color in
            self?.createChannel(name: name, purpose: purpose, icon: icon, color: color)
        }
        // M11: the New channel flow with "What can OpenDuet use here?"
        menu.createWithAccess = { [weak self] name, purpose, icon, color, access in
            self?.createChannel(name: name, purpose: purpose, icon: icon, color: color, access: access)
        }
        menu.setArchived = { [weak self] id, archived in self?.setChannelArchived(id, archived: archived) }
        // M9
        menu.update = { [weak self] id, name, purpose, icon, color in
            self?.updateChannel(id, name: name, purpose: purpose, icon: icon, color: color)
        }
        menu.delete = { [weak self] id in self?.deleteChannel(id) }
        menu.markRead = { [weak self] id in self?.markChannelRead(id) }
        return menu
    }

    private var connectorActions: ConnectorActions {
        var connectors = ConnectorActions()
        connectors.refresh = { [weak self] in self?.refreshConnectors() }
        connectors.search = { [weak self] query in self?.searchConnectors(query) }
        connectors.openDetail = { [weak self] toolkit in self?.openConnectorDetail(toolkit) }
        connectors.closeDetail = { [weak self] in self?.closeConnectorDetail() }
        connectors.connect = { [weak self] toolkit in self?.connect(toolkit: toolkit) }
        connectors.oauthFinished = { [weak self] id, callback in self?.oauthFinished(id, callback: callback) }
        connectors.setPolicy = { [weak self] toolkit, tool, mode in self?.setPolicy(toolkit: toolkit, tool: tool, mode: mode) }
        connectors.disconnect = { [weak self] toolkit, accountId in self?.disconnect(toolkit: toolkit, accountId: accountId) }
        return connectors
    }

    /// signOut and openNotificationSettings need the app; ShellHost (OpenDuetApp.swift) injects them.
    private var accountActions: AccountActions {
        var account = AccountActions()
        account.dismiss = { [weak self] in self?.dismissSheet() }
        account.refreshProfile = { [weak self] in self?.refreshProfile() }
        account.loadMemory = { [weak self] in self?.loadMemory() }
        account.saveMemory = { [weak self] document in self?.saveMemory(document) }
        account.updateNotifications = { [weak self] time, weekends in self?.updateNotifications(briefTime: time, weekendsOn: weekends) }
        account.refreshUsage = { [weak self] in self?.refreshUsage() }
        account.loadUsageStats = { [weak self] range in self?.loadUsageStats(range) }
        account.fullReset = { [weak self] in self?.fullReset() }
        account.sendFeedback = { [weak self] text in self?.sendFeedback(text) }
        return account
    }

    private var taskActions: TaskActions {
        var tasks = TaskActions()
        tasks.refresh = { [weak self] in self?.refreshTasks() }
        tasks.markComplete = { [weak self] id in self?.markTaskComplete(id) }
        tasks.completeWithUndo = { [weak self] id in self?.completeWithUndo(id) }
        tasks.undoComplete = { [weak self] in self?.undoTaskCompletion() }
        tasks.setReplyTo = { [weak self] quote in self?.setTaskReplyTo(quote) }
        tasks.archive = { [weak self] id in self?.archiveTask(id) }
        tasks.create = { [weak self] prompt in self?.createTask(prompt: prompt) }
        tasks.open = { [weak self] id in self?.openTask(id) }
        tasks.close = { [weak self] in self?.closeTask() }
        // M21: with the files uploaded in the task's own composer.
        tasks.reply = { [weak self] text, ids in self?.reply(text: text, attachmentIds: ids) }
        tasks.addAttachments = { [weak self] files in
            guard let self, let taskId = self.board.openTaskId else { return }
            self.addAttachments(files, taskId: taskId)
        }
        tasks.loadOlder = { [weak self] in self?.loadOlderTaskMessages() }
        tasks.addSuggestion = { [weak self] id in self?.addSuggestion(id) }
        tasks.hideSuggestion = { [weak self] id in self?.hideSuggestion(id) }
        tasks.scan = { [weak self] in self?.scan() }
        tasks.runNow = { [weak self] kind in self?.runNow(kind) }
        // M9
        tasks.setPinned = { [weak self] id, pinned in self?.setTaskPinned(id, pinned) }
        tasks.delete = { [weak self] id in self?.deleteTask(id) }
        tasks.loadRoutineRuns = { [weak self] id in self?.loadRoutineRuns(id) }
        tasks.runRoutine = { [weak self] id in self?.runRoutine(id) }
        tasks.setRoutinePaused = { [weak self] id, paused in self?.setRoutinePaused(id, paused) }
        tasks.updateRoutine = { [weak self] id, schedule, title in self?.updateRoutine(id, schedule: schedule, title: title) }
        // M22 (W3, ChatStore+Tasks)
        tasks.retry = { [weak self] id in self?.retryTask(id) }
        tasks.reopen = { [weak self] id in self?.reopenTask(id) }
        tasks.saveForLater = { [weak self] prompt in self?.saveForLater(prompt: prompt) }
        tasks.loadOlderResolved = { [weak self] in self?.loadOlderResolved() }
        tasks.search = { [weak self] query in self?.searchTasks(query) }
        tasks.openRoute = { [weak self] url in self?.openRoute(url) }
        return tasks
    }

    private var cardActions: CardActions {
        var cards = CardActions()
        cards.approve = { [weak self] messageId, approvalId, version in
            self?.approveCard(messageId: messageId, approvalId: approvalId, version: version)
        }
        cards.approveAlways = { [weak self] messageId, approvalId, version in
            self?.approveCard(messageId: messageId, approvalId: approvalId, version: version, always: true)
        }
        cards.decline = { [weak self] messageId, approvalId, version in
            self?.declineCard(messageId: messageId, approvalId: approvalId, version: version)
        }
        cards.action = { [weak self] messageId, action, itemId in
            self?.cardAction(messageId: messageId, action: action, itemId: itemId)
        }
        cards.sendText = { [weak self] text in self?.sendCardText(text) }
        cards.openAlert = { [weak self] action in self?.openAlert(action) }
        // M9
        cards.submitForm = { [weak self] id, answers, summary in self?.submitForm(messageId: id, answers: answers, summary: summary) }
        cards.dismissForm = { [weak self] id in self?.dismissForm(messageId: id) }
        // M12
        cards.retry = { [weak self] id, modelId in self?.retryModel(messageId: id, modelId: modelId) }
        return cards
    }
}
