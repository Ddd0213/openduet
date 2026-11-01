// Preview-only sample data for the onboarding illustrations (prompt L3, L23). Never used by
// the app: page 2's chips come from the user's server (L77).
import Foundation

#if DEBUG
enum OnboardingFixtures {
    /// Page 2's list exactly as L23 describes it: apps, then channels, then skills.
    static let setupChips: [OnboardingInfo.Chip] = [
        .init(kind: .app, label: "Gmail", toolkit: "gmail"),
        .init(kind: .app, label: "Calendar", toolkit: "googlecalendar"),
        .init(kind: .app, label: "Drive", toolkit: "googledrive"),
        .init(kind: .app, label: "Cloudflare Developer Platform", toolkit: "cloudflare"),
        .init(kind: .app, label: "Cloudinary", toolkit: "cloudinary"),
        .init(kind: .app, label: "Excalidraw", toolkit: "excalidraw"),
        .init(kind: .channel, label: "Finance Manager"),
        .init(kind: .channel, label: "Friend's mobile app analysis"),
        .init(kind: .channel, label: "Storage cleanup on mini"),
        .init(kind: .skill, label: "Google voice navigator"),
        .init(kind: .skill, label: "Studio image gen"),
        .init(kind: .skill, label: "X navigator"),
    ]
}
#endif
