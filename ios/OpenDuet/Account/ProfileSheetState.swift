// M19: what the settings (the profile sheet) get from the shell. Only the slices of ShellState
// they read, so a write elsewhere (the thread, an SSE event, the menu) doesn't redraw the sheet
// (ProfileSheet is Equatable on this). The models it loads itself live in ProfileSheetCache for
// the shell's lifetime, so a sheet reopened within a minute shows them at once and doesn't fetch
// them again (FetchFreshness).
import Foundation

struct ProfileSheetState: Hashable, Sendable {
    var profile: ProfileState
    var assistant: AssistantAccessState
    var usageScreen: UsageScreenState
    var cardRequests: ShellState.CardRequests
    /// profile > Files
    var mainFiles: FileListState
    /// a file tapped on the Files page previews over the sheet
    var filePreview: FilePreviewState?
    /// the channel sheet or the connector detail is up: the preview isn't shown from here
    var previewCovered: Bool

    init(_ state: ShellState) {
        profile = state.profile
        assistant = state.assistant
        usageScreen = state.usageScreen
        cardRequests = state.cardRequests
        mainFiles = state.files.mainFiles
        filePreview = state.files.preview
        previewCovered = state.files.channelSheet != nil || state.connectorDetail != nil
    }
}

/// The settings' own models and when they were fetched, kept while the shell lives (signing out
/// ends it).
@MainActor
final class ProfileSheetCache {
    /// models, skills and custom connectors
    lazy var settings = EverythingModel()
    /// GET / PUT /api/voice-settings
    lazy var voice = VoiceSettingsModel()
    var freshness = FetchFreshness()

    enum Part {
        static let profile = "profile"
        static let connectors = "connectors"
        static let settings = "settings"
        static let voice = "voice"
    }

    init() {}
}
