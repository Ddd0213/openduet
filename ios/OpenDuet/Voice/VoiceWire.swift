// The realtime voice's wire, the same for both providers: a WebSocket of JSON text frames
// (`LiveSocket`), a codec that turns the provider's frames into `EngineEvent`s and back, and what
// a session is set up with. Pure Foundation (host-tested): no audio, no URLSession here.
import Foundation

/// A provider's WebSocket, text frames each way. Tests replay a scripted one.
@MainActor
protocol LiveSocket: AnyObject {
    func send(_ text: String)
    /// The next frame; throws once the socket closed.
    func receive() async throws -> String
    func close()
    /// A WebSocket ping; `pong` runs on the main actor once it's answered (never when it isn't).
    func ping(_ pong: @escaping @MainActor () -> Void)
    /// The code the server closed it with (0 when it didn't say).
    var closeCode: Int { get }
    /// Why the server closed it, if it said.
    var closeReason: String { get }
}

/// Opens a provider's socket for a request (its URL or header holds the credential).
typealias LiveSocketFactory = @MainActor (URLRequest) -> any LiveSocket

/// What the provider said, in one vocabulary for both engines.
enum EngineEvent: Hashable, Sendable {
    /// The session is set up (Gemini setupComplete, StepFun session.created / updated).
    case ready
    /// PCM16 little-endian mono of the voice, at `rate` Hz.
    case audio(Data, rate: Int)
    /// What the user said: a piece to add (final false), or the whole utterance (final true).
    case inputText(String, final: Bool)
    /// StepFun: the conversation item the next final `inputText` belongs to.
    case inputItem(String)
    /// What the voice said: a piece to add (final false), or the whole utterance (final true).
    case outputText(String, final: Bool)
    /// The voice finished its turn (StepFun: response.done or response.cancelled).
    case turnComplete
    /// StepFun: the provider started a response (its own after the user's turn, or one asked for).
    case responseStarted
    /// The provider cut the voice short (the user talked over it).
    case interrupted
    /// The provider heard the user start talking (StepFun's server VAD).
    case speechStarted
    /// The provider heard the user stop talking (StepFun's server VAD).
    case speechStopped
    /// The voice calls one of the server's tools; `argumentsJSON` is a JSON object's text.
    case toolCall(id: String, name: String, argumentsJSON: String)
    /// Gemini: resume a dropped session with this.
    case resumeHandle(String)
    /// The provider ends this connection soon: carry on in a new one.
    case goAway
    /// Something went wrong; `fatal` = trying again won't help.
    case error(String, fatal: Bool)
}

/// What a session is set up with (from POST /api/calls). Holds no credential.
struct VoiceSessionConfig: Hashable, Sendable {
    var model: String
    var voice: String
    var instructions: String
    var tools: [VoiceTool]
    /// Gemini: the handle of the session to resume (nil = a new one).
    var resumeHandle: String?
}

/// One provider's protocol: the socket request, the frames the phone sends and how it reads the
/// provider's. Pure: no state of its own beyond the rates.
protocol VoiceCodec: Sendable {
    var engine: VoiceEngineKind { get }
    /// What the microphone is sent at (Gemini 16 kHz, StepFun 24 kHz).
    var inputRate: Int { get }
    /// What the voice arrives at (24 kHz for both).
    var outputRate: Int { get }
    /// The socket's request; the credential goes in the URL or a header, nowhere else.
    func request(url: String, credential: VoiceCredential) -> URLRequest?
    /// Sent once the socket is open.
    func setup(_ config: VoiceSessionConfig) -> [String]
    /// One provider frame as events (none when it says nothing the call needs).
    func decode(_ frame: String) -> [EngineEvent]
    /// A piece of the microphone (PCM16 at `inputRate`).
    func audio(_ pcm: Data) -> String
    /// The answer to a tool call (what's added to the conversation; `respond()` asks for the
    /// voice's answer when the provider needs that asked).
    func toolResult(id: String, name: String, result: String) -> [String]
    /// Something for the voice to say or mention (a cue), as a user turn it answers.
    func say(_ text: String) -> [String]
    /// Asks the voice to answer what was added. Empty when the provider answers by itself
    /// (Gemini). StepFun takes one response at a time: CallCore sends this only once the
    /// last one is done.
    func respond() -> [String]
    /// Cuts the voice short (barge-in); empty when the provider does it itself.
    func cancelResponse() -> [String]
    /// Takes a user turn out of the conversation (the voice's own echo); empty when it can't.
    func forget(item: String) -> [String]
    /// Whether the way the socket closed means trying again won't help.
    func isFatal(closeCode: Int) -> Bool
}

extension JSONValue {
    /// A wire frame: compact, keys sorted.
    var frame: String { text }
}

/// How the transcript and cues read to the voice model (the server's instructions explain them).
enum CueText {
    static func reply(_ text: String) -> String { "[OpenDuet replied] \(text)" }
    static func notice(_ text: String) -> String { "[Notice] \(text)" }
    static func progress(_ text: String) -> String { "[Progress] \(text)" }

    /// After a drop: the reply it cut, picked up where it stopped (what arrived was played).
    static func cutReply(_ said: String) -> String {
        guard !said.isEmpty else {
            return "[Notice] The connection dropped while you were answering the user and your reply was cut off. Answer their last turn again, briefly."
        }
        let tail = said.count > 200 ? "…" + said.suffix(200) : said
        return "[Notice] The connection dropped while you were speaking and your reply was cut off after: \"\(tail)\". Carry on from there in the same language; don't start over or repeat it, and mention the drop in a few words at most."
    }

    /// After a drop: the user's turn the provider had started to answer, nothing of it said yet.
    static func unansweredTurn(_ user: String) -> String {
        let quoted = user.isEmpty ? "" : " (they said: \"\(user.prefix(300))\")"
        return "[Notice] The connection dropped just as you were about to answer the user\(quoted). Answer them now."
    }

    /// After a drop: a tool's answer the voice hadn't told the user yet.
    static func lostAnswer(_ tool: String, _ result: String) -> String {
        "[Notice] The connection dropped before you told the user the answer to \(tool) (it went through; don't call it again): \(result.prefix(1000)) Tell them now if you haven't yet."
    }
}
