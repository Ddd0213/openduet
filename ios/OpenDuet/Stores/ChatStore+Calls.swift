// M13: the chat's side of a voice call (the call itself is the app's CallSession). The SSE
// `call` cues go out through `onCallCue` (route); while a call is on, GET /api/events stays open
// in the background (the screen locked, the app behind another); the call's line from /end goes
// into the thread at once (the `message` event that follows is the same message).
import Foundation

extension ChatStore {
    /// A call started or finished: hold the event stream open while it lasts.
    func holdStreamForCall(_ hold: Bool) {
        guard !tornDown, callHoldsStream != hold else { return }
        callHoldsStream = hold
        if hold || foregroundActive { stream?.start() } else { stream?.stop() }
    }

    /// The call's line (POST /api/calls/:id/end): shown now in the thread it belongs to.
    func insertCallMessage(_ message: Message) {
        reducer.accept(message)
    }
}
