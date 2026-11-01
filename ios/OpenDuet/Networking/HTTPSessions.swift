// The URLSessions the app talks to its server with. No cookies (the bearer token is the only
// credential) and no waiting for connectivity: an unreachable server fails fast so the app
// can show "Can't reach your server · Retrying" and queue messages (L184).
import Foundation

enum HTTPSessions {
    /// API calls, SSE streams and uploads; nothing is cached.
    static let api = URLSession(configuration: configuration(timeout: 30))

    /// Image and file bytes (L172, L186); cached on disk through `fileCache` by APIClient.
    static let files = URLSession(configuration: configuration(timeout: 60))

    /// Bytes of GET /api/files/<id>/content, which never change for an id. Cleared on sign-out.
    static let fileCache: URLCache = {
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appending(path: "ServerFiles", directoryHint: .isDirectory)
        return URLCache(memoryCapacity: 8 << 20, diskCapacity: 300 << 20, directory: directory)
    }()

    static func purgeFiles() {
        fileCache.removeAllCachedResponses()
    }

    private static func configuration(timeout: TimeInterval) -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = timeout
        return config
    }
}
