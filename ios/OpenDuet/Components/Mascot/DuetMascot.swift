// The OpenDuet mascot (M29): the circle with two eyes of MascotFace, alive. `pose` is what the
// assistant is doing; with `animated` it moves continuously (MascotMotion: breathing, blinks,
// glances, scans, hops), and a pose change morphs over 0.5 s, the eyes first. `event` plays a
// one-shot reaction (MascotReactions) each time it changes, then the pose carries on; it plays
// on still mascots too. Reduce Motion: the key pose only, morphs and reactions in place.
import SwiftUI

struct DuetMascot: View {
    var pose: MascotPose = .idle
    /// Diameter of the circle; the frame (MascotPaint.frame) leaves room for hops and squashes.
    var size: CGFloat = 30
    /// Move continuously (the header, the Build view, the Computer views).
    var animated = false
    /// A new value plays its reaction once (nil = none). History never sets one.
    var event: MascotEvent? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// M19: the side menu covers the header or slides: the timeline stops where it is.
    @Environment(\.mascotPaused) private var paused
    /// Per mascot, so two on screen don't blink together.
    @State private var seed = UInt64.random(in: 0...UInt64.max)
    @State private var poseStart = Date.now
    @State private var shownPose: MascotPose?
    @State private var fromFace: MascotFace?
    @State private var morphStart = Date.distantPast
    @State private var reaction: MascotReaction?
    @State private var reactionStart = Date.distantPast
    /// The frame shown when the reaction started (a reaction cut short blends from it).
    @State private var reactionFrom: MascotFace?
    /// A morph or reaction is playing: the timeline runs even when still or paused.
    @State private var busy = false
    @State private var busyUntil = Date.distantPast

    private var still: Bool { reduceMotion || !animated }

    var body: some View {
        let box = MascotPaint.frame(size)
        TimelineView(.animation(paused: (still || paused) && !busy)) { context in
            let shown = face(at: context.date)
            Canvas { gc, canvas in
                MascotPaint.draw(shown, diameter: size, in: &gc, size: canvas)
            }
        }
        .frame(width: box.width, height: box.height)
        .accessibilityHidden(true)
        .onAppear { if shownPose == nil { shownPose = pose } }
        .onChange(of: pose) { old, new in
            let now = Date.now
            fromFace = baseFace(at: now, pose: shownPose ?? old)
            shownPose = new
            poseStart = now
            morphStart = now
            keepBusy(until: now.addingTimeInterval(MascotMotion.morphDuration))
        }
        .onChange(of: event) { _, new in
            guard let new else { return }
            let now = Date.now
            reactionFrom = face(at: now)
            reaction = new.reaction
            reactionStart = now
            keepBusy(until: now.addingTimeInterval(new.reaction.duration))
        }
        .task(id: busyUntil) {
            let wait = busyUntil.timeIntervalSinceNow
            guard wait > 0 else { busy = false; return }
            try? await Task.sleep(for: .seconds(wait + 0.05))
            if !Task.isCancelled { busy = false }
        }
    }

    private var energy: Double { MascotMotion.energy(diameter: Double(size)) }

    /// The state's frame, morphing from the previous state's for the first 0.5 s.
    private func baseFace(at date: Date, pose: MascotPose) -> MascotFace {
        let target = still ? pose.keyFace
            : MascotMotion.face(pose, t: max(date.timeIntervalSince(poseStart), 0), seed: seed, energy: energy)
        let p = date.timeIntervalSince(morphStart) / MascotMotion.morphDuration
        guard let fromFace, p < 1 else { return target }
        return MascotMotion.morph(fromFace, target, max(p, 0), plain: reduceMotion)
    }

    /// What is drawn: the state's frame with the reaction playing over it.
    private func face(at date: Date) -> MascotFace {
        let base = baseFace(at: date, pose: shownPose ?? pose)
        guard let reaction else { return base }
        let t = date.timeIntervalSince(reactionStart)
        guard t >= 0, t < reaction.duration else { return base }
        let reacting = reduceMotion
            ? MascotMotion.reactStill(reaction, base: base, t: t)
            : MascotMotion.react(reaction, base: base, t: t, energy: energy)
        // A reaction that cut another short blends in from where that one was over 0.1 s.
        guard let reactionFrom, t < 0.1 else { return reacting }
        return MascotFace.lerp(reactionFrom, reacting, MascotCurve.smooth(t / 0.1))
    }

    private func keepBusy(until end: Date) {
        busy = true
        if end > busyUntil { busyUntil = end }
    }
}

extension EnvironmentValues {
    /// M19: animated mascots hold their current frame (SideMenuContainer sets it while the menu is
    /// open or sliding, so the header's timeline doesn't redraw under the slide).
    @Entry var mascotPaused = false
}

#Preview("States and reactions") {
    @Previewable @State var event: MascotEvent?
    @Previewable @State var size: CGFloat = 34
    ScrollView {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(MascotPose.allCases, id: \.self) { pose in
                HStack(spacing: 16) {
                    Text(verbatim: pose.rawValue).font(.caption).frame(width: 70, alignment: .leading)
                    DuetMascot(pose: pose, size: size, animated: true, event: event)
                        .floatingCircle(size * 64 / 34, interactive: false)
                    DuetMascot(pose: pose, size: 15, animated: true, event: event)
                    DuetMascot(pose: pose, size: 30, animated: false, event: event)
                }
            }
            HStack {
                ForEach(MascotReaction.allCases, id: \.self) { reaction in
                    Button(reaction.rawValue) { event = MascotEvent(reaction) }
                        .buttonStyle(.bordered)
                }
            }
            Picker(selection: $size) {
                Text(verbatim: "34").tag(CGFloat(34))
                Text(verbatim: "56").tag(CGFloat(56))
            } label: { Text(verbatim: "Size") }
                .pickerStyle(.segmented)
        }
        .padding()
    }
    .background(Palette.background)
}

#Preview("Cycling") {
    @Previewable @State var index = 0
    @Previewable @State var event: MascotEvent?
    VStack(spacing: 12) {
        DuetMascot(pose: MascotPose.allCases[index % MascotPose.allCases.count], size: 34, animated: true, event: event)
            .floatingCircle(64, interactive: false)
        Text(verbatim: "\(MascotPose.allCases[index % MascotPose.allCases.count].rawValue) · \(event?.reaction.rawValue ?? "-")")
            .font(.caption)
    }
    .padding(40)
    .background(Palette.background)
    .task {
        // Every 4 s the next state; a reaction 2 s into each.
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            event = MascotEvent(MascotReaction.allCases[index % MascotReaction.allCases.count])
            try? await Task.sleep(for: .seconds(2))
            index += 1
        }
    }
}
