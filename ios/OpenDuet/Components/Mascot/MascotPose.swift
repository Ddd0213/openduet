// The mascot's states and one-shot reactions (M29) by meaning; each maps to a key pose of
// MascotFace. Foundation only, like MascotFace, so the motion code stays testable on its own.
import Foundation

/// What the assistant is doing (the live status pill), each a continuous motion around its key pose.
enum MascotPose: String, CaseIterable, Sendable {
    /// Breathes, blinks every few seconds, now and then glances aside.
    case idle
    /// "Thinking it through": looks up right, one eye higher, slowly tilts its head.
    case thinking
    /// The looking-up group: quick scans left and right, the body turning after the eyes.
    case searching
    /// "Writing a draft": looks down and reads along a line, left to right, with small nods.
    case writing
    /// "Working on your tasks": eyes narrowed to pills, small rhythmic hops.
    case tasks
    /// "Starting a task": squats, springs up, eyes wide.
    case starting
    /// The working group: looks down to the side at a screen, now and then up at you.
    case working

    /// The approved still frame of this state.
    var keyFace: MascotFace {
        switch self {
        case .idle: .neutral
        case .thinking: .thinking
        case .searching: .searching
        case .writing: .writing
        case .tasks: .tasks
        case .starting: .starting
        case .working: .working
        }
    }

    /// The pose for a live status key (nil = idle).
    init(status: StatusKey?) {
        switch status {
        case nil: self = .idle
        case .thinking: self = .thinking
        case .writingDraft: self = .writing
        case .workingTasks: self = .tasks
        case .startingTask: self = .starting
        case .searchingWeb, .lookingUp, .checkingMemory, .searchingEmail, .checkingFiles, .checkingCalendar, .checking, .readingNow:
            self = .searching
        case .working, .workingBrowser, .wakingWorkspace: self = .working
        }
    }
}

/// A one-shot reaction; the mascot plays it once and returns to its current state.
enum MascotReaction: String, CaseIterable, Sendable {
    /// A background task finished, a Make build is ready: happy arcs and one hop.
    case done
    /// A new model error card: short drooping eyes, the body slumps.
    case error
    /// A new approval, sign-in or connection request card: looks at you, eyes wide, leans in twice.
    case needsYou
    /// Tapped: a blink and a jelly wobble.
    case tap

    /// Seconds from start until it is back in the current state.
    var duration: Double {
        switch self {
        case .done: 1.25
        case .error: 1.5
        case .needsYou: 1.35
        case .tap: 0.6
        }
    }
}

/// One firing of a reaction. Every value is new (its own id), so the same reaction twice in a row
/// still plays twice: DuetMascot plays it whenever its `event` changes.
struct MascotEvent: Hashable, Sendable {
    let reaction: MascotReaction
    let id: UUID

    init(_ reaction: MascotReaction) {
        self.reaction = reaction
        self.id = UUID()
    }
}
