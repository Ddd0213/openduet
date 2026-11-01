// The run records' fixed words (M8 contract §1 and §4). The server sends a step title as a key
// (run.step.exec) or as text; the app turns a key into its English text, which is the String
// Catalog key, so zh-Hans comes from Localizable.xcstrings. Built-in tool and app names the
// server sends as plain strings ("OpenDuet's computer", "Run commands") are looked up the same
// way; Composio names stay as sent. Pure Foundation (host-tested).
import Foundation

enum RunCopy {
    /// The English (catalog) text of a contract title key; nil for an unknown key.
    static func title(key: String) -> LocalizedStringResource? {
        switch key {
        case "run.step.text": "Replied"
        case "run.step.thinking": "Thought it through"
        case "run.step.error": "Something went wrong"
        case "run.step.exec": "Ran a command"
        case "run.step.navigate": "Opened a page"
        case "run.step.read_page": "Read a page"
        case "run.step.browse": "Used the browser"
        case "run.step.screenshot": "Took a screenshot"
        case "run.step.files_list": "Listed files"
        case "run.step.files_read": "Read a file"
        case "run.step.files_write": "Wrote a file"
        case "run.step.send_file": "Sent a file"
        case "run.step.web_search": "Searched the web"
        case "run.step.web_fetch": "Read a web page"
        case "run.step.memory": "Checked memory"
        case "run.step.remember": "Saved to memory"
        case "run.step.past_chats": "Searched past chats"
        case "run.step.task": "Started a task"
        case "run.step.task_progress": "Updated the task"
        case "run.step.make": "Built in Make"
        case "run.step.approval": "Asked for approval"
        // M25: the built-in connectors (web_search is above)
        case "run.step.weather": "Checked the weather"
        case "run.step.exchange_rate": "Checked exchange rates"
        case "run.step.read_feed": "Read a feed"
        case "run.step.tool": "Used a tool"
        // M27: update_artifact_data (the step's grey line is the paths it changed)
        case "run.step.artifact_data": "Updated dashboard data"
        case "run.title.brief": "Morning brief"
        case "run.title.checkin": "Check-in"
        case "run.title.scan": "First-day scan"
        case "run.title.build": "Make build"
        default: nil
        }
    }

    /// Every key of the contract's table (for the tests).
    static let contractKeys = [
        "run.step.text", "run.step.thinking", "run.step.error", "run.step.exec", "run.step.navigate",
        "run.step.read_page", "run.step.browse", "run.step.screenshot", "run.step.files_list",
        "run.step.files_read", "run.step.files_write", "run.step.send_file", "run.step.web_search",
        "run.step.web_fetch", "run.step.memory", "run.step.remember", "run.step.past_chats",
        "run.step.task", "run.step.task_progress", "run.step.make", "run.step.approval",
        "run.step.tool", "run.title.brief", "run.title.checkin", "run.title.scan", "run.title.build",
        "run.step.weather", "run.step.exchange_rate", "run.step.read_feed",
        "run.step.artifact_data",
    ]

    /// A step or run title as shown: the catalog text of a known key, the text as written, or
    /// (an unknown key from a newer server) "Used a tool".
    static func resolve(_ phrase: Phrase) -> Resolved {
        if let key = phrase.key {
            if let resource = title(key: key) { return .localized(resource) }
            if phrase.text == nil { return .localized("Used a tool") }
        }
        return .text(phrase.text ?? "")
    }

    enum Resolved: Sendable {
        case localized(LocalizedStringResource)
        case text(String)
    }

    /// The built-in names the server sends as plain strings (approval previews, task update
    /// sources, run step apps), mapped to catalog text; nil = a Composio name, shown as sent.
    /// M29: rows stored under an older name ("Claude", or "Open Duet" with a space) show the new one.
    static func builtInName(_ name: String) -> LocalizedStringResource? {
        switch name {
        case "OpenDuet's computer", "Open Duet's computer", "Claude's computer": "OpenDuet's computer"
        case "OpenDuet", "Open Duet", "Claude": "OpenDuet"
        case "Run commands": "Run commands"
        case "Command": "Command"
        case "List files": "List files"
        case "Read file": "Read file"
        case "Read files": "Read files"
        case "Write file": "Write file"
        case "Write files": "Write files"
        case "Folder": "Folder"
        case "Path": "Path"
        case "Url", "URL": "URL"
        default: nil
        }
    }

    /// The row label that holds a shell command (computer_exec's preview): shown monospaced.
    static func isCommandLabel(_ label: String) -> Bool {
        label == "Command"
    }

    /// What kind of run it is, for the detail's subtitle.
    static func kind(_ kind: RunKind) -> LocalizedStringResource {
        switch kind {
        case .chat: "Chat"
        case .task: "Task"
        case .brief: "Morning brief"
        case .checkin: "Check-in"
        case .scan: "First-day scan"
        case .build: "Make build"
        case .routine: "Scheduled task"
        }
    }
}
