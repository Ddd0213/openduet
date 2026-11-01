// API failures (docs/API.md "Errors"): the server's ApiError `code` mapped to a Swift case,
// plus "couldn't reach the server". Views show `localizedReason` as an inline grey line.
import Foundation

enum APIError: Error, Hashable, Sendable {
    /// 401 on a signed-in request: the session expired or was revoked.
    case unauthorized
    /// Sign-in only: "Wrong username or password."
    case invalidCredentials
    case rateLimited
    case validationFailed(field: String?, message: String)
    case notFound
    case staleVersion
    case expired
    case tooLarge
    case unsupportedType
    case notConfigured
    case usageLimited
    case server(status: Int, code: String)
    /// No connection, timeout, DNS, TLS, or a gateway in front of the server is down.
    case unreachable
    /// A 2xx whose body didn't decode, or a URL the client refuses to build.
    case invalidResponse

    init(status: Int, body: Data) {
        let detail = try? JSONCoding.decoder().decode(ApiErrorBody.self, from: body).error
        switch detail?.code {
        case "unauthorized": self = .unauthorized
        case "invalid_credentials": self = .invalidCredentials
        case "rate_limited": self = .rateLimited
        case "validation_failed": self = .validationFailed(field: detail?.field, message: detail?.message ?? "")
        case "not_found": self = .notFound
        case "stale_version": self = .staleVersion
        case "expired": self = .expired
        case "too_large": self = .tooLarge
        case "unsupported_type": self = .unsupportedType
        case "not_configured": self = .notConfigured
        case "usage_limited": self = .usageLimited
        case let code?: self = .server(status: status, code: code)
        case nil: self = APIError(status: status)
        }
    }

    /// Fallback when the body isn't an ApiError (a proxy page, an empty body).
    private init(status: Int) {
        switch status {
        case 401: self = .unauthorized
        case 404: self = .notFound
        case 409: self = .staleVersion
        case 410: self = .expired
        case 413: self = .tooLarge
        case 415: self = .unsupportedType
        case 429: self = .rateLimited
        case 502, 503, 504: self = .unreachable
        default: self = .server(status: status, code: "internal")
        }
    }

    /// Maps a URLSession failure; cancellation stays a CancellationError.
    static func transport(_ error: any Error) -> any Error {
        if error is CancellationError { return error }
        if let url = error as? URLError {
            return url.code == .cancelled ? CancellationError() : APIError.unreachable
        }
        if error is APIError { return error }
        return APIError.unreachable
    }

    /// True when the request may succeed later unchanged (queue it and retry on reconnect).
    var isConnectivity: Bool { self == .unreachable }

    /// One short line for inline errors.
    var localizedReason: String {
        switch self {
        case .invalidCredentials: String(localized: "Wrong username or password.")
        case .rateLimited: String(localized: "Too many attempts. Try again in a moment.")
        case .tooLarge: String(localized: "Too large (25 MB max)")
        case .unsupportedType: String(localized: "This file type isn't supported")
        case .usageLimited: String(localized: "Usage limit reached")
        case .unreachable: String(localized: "Can't reach your server.")
        case .unauthorized: String(localized: "Sign in again.")
        // M20
        case .server(_, "computer_busy"): String(localized: "OpenDuet's computer is busy. Try again when it's done.")
        case .server(_, "always_not_allowed"): String(localized: "This one always asks.")
        // M27 browser (the full-screen view's tab strip and address bar)
        case .server(_, "take_over_first"): String(localized: "Take over to use the browser.")
        case .server(_, "tabs_unsupported"): String(localized: "OpenDuet's computer needs an update for tabs.")
        default: String(localized: "Something went wrong.")
        }
    }
}
