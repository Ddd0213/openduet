// M11: the signed-in APIClient for pages that load their own data (the soul and memory editors,
// the skills library, custom connectors, channel access). ShellHost sets it from the ChatStore;
// previews leave it nil and pass a fixed state instead.
import SwiftUI

extension EnvironmentValues {
    @Entry var apiClient: APIClient? = nil
}
