// PCM helpers for the call's audio: Float32 ↔ Int16 little-endian, a streaming resampler (the
// microphone's rate → 16 kHz for Gemini or 24 kHz for StepFun; an averaging pre-filter when it
// goes down, so 48 kHz voice doesn't alias), the loudness level, and 20 ms chunks. Pure
// Foundation (host-tested); the realtime audio thread uses these without touching any actor.
import Foundation

enum PCM {
    /// The length of one chunk sent up: 20 ms (the provider's VAD hears the user sooner, and a
    /// chunk is never most of a short word).
    static let chunkMilliseconds = 20

    /// Bytes of one chunk of mono PCM16 at `rate`.
    static func chunkBytes(rate: Int) -> Int { rate * chunkMilliseconds / 1000 * 2 }

    /// Float32 samples (−1…1, clipped) → PCM16 little-endian.
    static func int16(_ samples: [Float]) -> Data {
        var data = Data(count: samples.count * 2)
        data.withUnsafeMutableBytes { raw in
            for (index, sample) in samples.enumerated() {
                let clipped = max(-1, min(1, sample))
                let value = Int16(clipped < 0 ? clipped * 32768 : clipped * 32767)
                raw.storeBytes(of: value.littleEndian, toByteOffset: index * 2, as: Int16.self)
            }
        }
        return data
    }

    /// PCM16 little-endian → Float32 samples (−1…1). An odd last byte is ignored.
    static func floats(_ data: Data) -> [Float] {
        let count = data.count / 2
        var out = [Float](repeating: 0, count: count)
        data.withUnsafeBytes { raw in
            for index in 0..<count {
                let value = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                out[index] = Float(value) / 32768
            }
        }
        return out
    }

    /// Loudness 0…1: the RMS in dB, −50 dB (a quiet room) … 0 dB.
    static func level(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        let db = 10 * log10(max(sum / Float(samples.count), 1e-10))
        return min(1, max(0, (db + 50) / 50))
    }

    /// The whole of `samples` at another rate, in one go.
    static func resample(_ samples: [Float], from source: Int, to target: Int) -> [Float] {
        var resampler = Resampler(from: source, to: target)
        return resampler.process(samples)
    }
}

/// A streaming resampler: buffers from the microphone in, a steady stream at `target` out, with
/// no seam between buffers. Linear interpolation; going down, each output sample first averages
/// the input samples it covers (a box filter against aliasing).
struct Resampler: Sendable {
    let source: Int
    let target: Int
    /// Input samples per output sample.
    private let step: Double
    /// Where the next output sample falls, in input samples from `history`'s start.
    private var position: Double = 0
    /// The tail of the previous input still needed (interpolation and the filter).
    private var history: [Float] = []

    init(from source: Int, to target: Int) {
        self.source = max(1, source)
        self.target = max(1, target)
        step = Double(self.source) / Double(self.target)
    }

    mutating func process(_ input: [Float]) -> [Float] {
        if source == target { return input }
        let samples = history + input
        guard !samples.isEmpty else { return [] }
        let width = max(1, Int(step.rounded(.down)))
        var out: [Float] = []
        out.reserveCapacity(Int(Double(input.count) / step) + 2)
        while position + 1 < Double(samples.count) {
            let base = Int(position)
            let fraction = Float(position - Double(base))
            if step > 1 {
                // The mean of the `width` samples up to this one, then interpolated.
                out.append(Self.mean(samples, end: base, width: width) * (1 - fraction)
                    + Self.mean(samples, end: base + 1, width: width) * fraction)
            } else {
                out.append(samples[base] * (1 - fraction) + samples[base + 1] * fraction)
            }
            position += step
        }
        // Keep what the next call still reads: the filter's reach back from the next position.
        let keepFrom = max(0, min(samples.count, Int(position) - width))
        history = Array(samples[keepFrom...])
        position -= Double(keepFrom)
        return out
    }

    private static func mean(_ samples: [Float], end: Int, width: Int) -> Float {
        let start = max(0, end - width + 1)
        var sum: Float = 0
        for index in start...end { sum += samples[index] }
        return sum / Float(end - start + 1)
    }
}

/// Cuts a stream of PCM16 into equal chunks (20 ms at the rate it was made for).
struct PCMChunker: Sendable {
    let chunkBytes: Int
    private var buffer = Data()

    init(rate: Int) { chunkBytes = PCM.chunkBytes(rate: rate) }

    /// The whole chunks so far; the rest waits for the next call.
    mutating func push(_ pcm: Data) -> [Data] {
        buffer.append(pcm)
        var chunks: [Data] = []
        while buffer.count >= chunkBytes {
            chunks.append(Data(buffer.prefix(chunkBytes)))
            buffer.removeFirst(chunkBytes)
        }
        return chunks
    }
}
