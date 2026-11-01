// The live screen inside a card (the chat's live browser card, the "OpenDuet's computer"
// detail): the newest frame, filled to the card's width from the top of the page. While `live`
// it follows the stream and keeps it open; afterwards it holds the last frame it showed (or a
// still page placeholder). Before the first frame it pulses; while reconnecting it dims.
// The box stays the size the card gives it (16:10). M27 C2: the default 1280 × 800 page fills it
// exactly, uncropped; a portrait frame (a portrait or headed deployment, M20b) is fitted to the
// box width from its top, so its top shows and the bottom is cropped.
import SwiftUI
import UIKit

struct LiveScreenImage: View {
    var screen: LiveScreen?
    var live: Bool

    @State private var image: UIImage?
    @State private var shownFrame = -1

    var body: some View {
        let frameNumber = live ? (screen?.frameNumber ?? 0) : -1
        let reconnecting = live && screen?.connection == .reconnecting
        ZStack(alignment: .top) {
            if let image {
                // The box keeps the size it is given (the cards' 16:10); the frame is placed in it
                // by ComputerGeometry.cardFill (the 1280 × 800 page exactly; a portrait frame's
                // overflow cropped). A filled image on its own would report its own height and
                // stretch the card.
                GeometryReader { proxy in
                    let rect = ComputerGeometry.cardFill(frame: image.size, in: proxy.size)
                    Image(uiImage: image)
                        .resizable()
                        .frame(width: rect.width, height: rect.height)
                        .offset(x: rect.minX, y: rect.minY)
                }
                .clipped()
                .opacity(reconnecting ? 0.55 : 1)
                .transition(.opacity)
            } else {
                BrowserPageSkeleton(pulsing: live)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .clipped()
        .animation(.easeInOut(duration: 0.25), value: image == nil)
        .animation(.easeInOut(duration: 0.25), value: reconnecting)
        .task(id: frameNumber) {
            guard live, let data = screen?.frame else { return }
            let number = frameNumber
            let decoded = await LiveFrameDecoder.decode(data)
            // A newer frame may have been decoded meanwhile; never step back.
            if let decoded, number > shownFrame {
                shownFrame = number
                image = decoded
            }
        }
        .liveScreenDemand(screen, active: live)
        .accessibilityHidden(true)
    }
}
