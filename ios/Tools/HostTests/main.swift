// Entry point for the Mac host build of the data-layer tests (see run.sh): runs every
// Swift Testing @Test compiled into this executable and exits non-zero on any failure.
import Testing

await Testing.__swiftPMEntryPoint() as Never
