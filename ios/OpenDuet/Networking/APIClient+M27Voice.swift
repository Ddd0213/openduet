// M27 voice routes: POST /api/transcriptions (multipart `file` WAV + `language`) with the saved
// cloud recognizer. 502 transcription_failed carries the server's plain words, kept here as
// TranscriptionFailure (APIError keeps only the code). The audio is sent once and never logged.
import Foundation

extension APIClient {
    /// The text of a WAV clip ("" when nothing was said).
    nonisolated func transcribe(wav: Data, language: String) async throws -> String {
        guard wav.count <= TranscriptionLimits.maxBytes else { throw APIError.tooLarge }
        let form = MultipartForm()
        var request = try makeRequest("POST", "/api/transcriptions")
        request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        // The server gives the provider 60 s.
        request.timeoutInterval = 75
        request.httpBody = form.body(
            fields: [("language", language)], field: "file", fileName: "dictation.wav", mime: "audio/wav", data: wav
        )
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await HTTPSessions.api.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        if let http = response as? HTTPURLResponse, http.statusCode == 502,
           let detail = try? JSONCoding.decoder().decode(ApiErrorBody.self, from: data).error,
           detail.code == TranscriptionRefusal.transcriptionFailed.rawValue {
            throw TranscriptionFailure(message: detail.message.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        try check(response, body: data)
        return try decode(TranscriptionResponse.self, from: data).text
    }
}
