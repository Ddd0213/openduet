// A multipart/form-data body with one file part (POST /api/channels/:id/files, field "file").
// M27: text fields may go before the file part (POST /api/transcriptions: `language`).
import Foundation

struct MultipartForm: Sendable {
    let boundary = "duet-" + UUID().uuidString

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    func body(field: String, fileName: String, mime: String, data: Data) -> Data {
        body(fields: [], field: field, fileName: fileName, mime: mime, data: data)
    }

    /// Text fields (name, value) in order, then the file part.
    func body(fields: [(String, String)], field: String, fileName: String, mime: String, data: Data) -> Data {
        var body = Data()
        for (name, value) in fields {
            body.append(Data("--\(boundary)\r\n".utf8))
            body.append(Data("Content-Disposition: form-data; name=\"\(Self.safe(name))\"\r\n\r\n".utf8))
            body.append(Data(value.utf8))
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"\(field)\"; filename=\"\(Self.safe(fileName))\"\r\n".utf8))
        body.append(Data("Content-Type: \(mime.isEmpty ? "application/octet-stream" : mime)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    /// Quotes and line breaks would end the header early; the server stores its own safe name.
    private static func safe(_ text: String) -> String {
        text.replacingOccurrences(of: "\"", with: "'")
            .components(separatedBy: .newlines).joined(separator: " ")
    }
}

/// Reports upload progress (0...1) of one task.
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    private let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}
