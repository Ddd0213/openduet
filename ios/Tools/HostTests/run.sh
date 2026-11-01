#!/usr/bin/env bash
# Builds and runs the logic tests (OpenDuetTests/Data*.swift, Markdown*.swift, Swift Testing)
# on the Mac with plain swiftc: no Xcode project, no simulator. Only Foundation-level sources
# are compiled: the models, the shell contract, the SSE parser, the server address rules,
# backoff, APIError, the thread reducer and the markdown parser.
#
#   ios/Tools/HostTests/run.sh            # build + run
#   ios/Tools/HostTests/run.sh --filter "Thread reducer"   # extra args go to the test runner
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios="$(cd "$here/../.." && pwd)"
app="$ios/OpenDuet"

out="${HOST_TESTS_OUT:-$(mktemp -d)}"
if [[ -z "${HOST_TESTS_OUT:-}" ]]; then trap 'rm -rf "$out"' EXIT; fi
mkdir -p "$out"

developer="$(xcode-select -p)"
frameworks="$developer/Platforms/MacOSX.platform/Developer/Library/Frameworks"
libs="$developer/Platforms/MacOSX.platform/Developer/usr/lib"
plugins="$developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing"

sources=(
  "$app"/Models/*.swift
  "$app/App/ShellContract.swift"
  "$app/App/TasksContract.swift"
  "$app/App/AccountContract.swift"
  "$app/App/ComputerContract.swift"
  "$app/App/MakeContract.swift"
  "$app/Networking/ServerAddress.swift"
  "$app/Networking/LocalHost.swift"
  "$app/Networking/SSEParser.swift"
  "$app/Networking/Backoff.swift"
  "$app/Networking/APIError.swift"
  "$app/Connectors/M17Rules.swift"
  "$app/Stores/ThreadReducer.swift"
  "$app/Stores/TasksReducer.swift"
  "$app/Stores/TaskSession.swift"
  "$app/Stores/TaskBoard.swift"
  "$app/Stores/DuetRoute.swift"
  # M9: form submit bookkeeping
  "$app/Stores/FormSubmit.swift"
  # M4 data logic (pure Foundation): side menu, account sheets, onboarding gate, notification rules
  "$app/Stores/ChannelMenu.swift"
  # M16: the recently left channel threads (ParkedThreads.recent)
  "$app/Stores/ThreadCache.swift"
  "$app/Stores/AccountBoard.swift"
  "$app/Session/OnboardingGate.swift"
  "$app/App/NotificationsRules.swift"
  "$ios"/OpenDuetTests/Data*.swift
  # M2 UI logic (pure Foundation): markdown parser, phrase / date formatting, thread rows
  "$app"/Components/Markdown/MarkdownModel.swift
  "$app"/Components/Markdown/MarkdownParser*.swift
  "$app"/Components/Markdown/MarkdownInline*.swift
  "$app/Components/PhraseFormatter.swift"
  "$app/Components/ChatDateFormat.swift"
  "$app/Components/AppLocale.swift"
  "$app/Chat/ThreadLayout.swift"
  # M18: when a task result bubble folds
  "$app/Chat/TaskResultRules.swift"
  # M8 (pure Foundation): run records, composer rules, approval fold, task thread filter
  "$app/App/RunsContract.swift"
  "$app/Stores/RunsBoard.swift"
  "$app/Runs/RunCopy.swift"
  "$app/Chat/Composer/ComposerRules.swift"
  "$app/Chat/Cards/ApprovalFold.swift"
  "$app/Tasks/TaskThreadFilter.swift"
  # M3 UI logic (pure Foundation): task grouping / search, card formatting
  "$app/Tasks/TaskGrouping.swift"
  "$app/Chat/Cards/CardFormat.swift"
  "$app/Menu/MenuTree.swift"
  # M19 (pure Foundation): the page hierarchy in sheets (push / pop / replace, the edge swipes'
  # release) and when the settings fetch a part again
  "$app/Components/PushStackRules.swift"
  "$app/Account/FetchFreshness.swift"
  "$app/Chat/Cards/FormLogic.swift"
  "$app/Account/UsageMath.swift"
  "$app/Tasks/ScheduleCopy.swift"
  "$app/Stores/MakeReducer.swift"
  "$app/Stores/MakeGallery.swift"
  "$app/Make/MakeCopy.swift"
  "$ios"/OpenDuetTests/Markdown*.swift
  "$ios"/OpenDuetTests/UI*.swift
  # M10a
  "$app/Chat/ThreadScrollRules.swift"
  # M10b (pure Foundation): Make FAB fade, task row menu + Rename rule, channel ink
  "$app/Make/FABFadeRule.swift"
  "$app/Tasks/TaskRowMenuModel.swift"
  "$app/Components/ChannelInk.swift"
  # M11a (pure Foundation): chat card rules, connect answer, New channel access picks
  "$app/Chat/Cards/ChannelCardRules.swift"
  "$app/Stores/ConnectionAnswer.swift"
  "$app/Menu/NewChannelAccess.swift"
  # M11b (pure Foundation): OpenDuet sheet pages: labels, soul / fact / skill rules, import selection,
  # channel switches, Add connector and Edit connection forms
  "$app/Settings/SettingsRules.swift"
  # M22 W4 (pure Foundation): Setup rows and fixes, Appearance, Language
  "$app/Settings/SetupRules.swift"
  "$app/Settings/ConnectorFormRules.swift"
  "$app/Settings/ConnectorEditDraft.swift"
  # M12 (pure Foundation): the thinking ladder and usable models, the provider forms, the model
  # editor, the remote picker and channel picker picks, the model_error card phases
  "$app/Settings/Models/ModelRules.swift"
  "$app/Settings/Models/ProviderDraft.swift"
  "$app/Settings/Models/ModelEditDraft.swift"
  "$app/Settings/Models/ModelChoiceRules.swift"
  "$app/Chat/Cards/ModelErrorRules.swift"
  # M13 (pure Foundation): the voice call's wire, both provider codecs, the transcript, PCM and the
  # call's state machine (CallCore); the chat's call line and the voice settings' rules
  "$app/Voice/VoiceWire.swift"
  "$app/Voice/GeminiCodec.swift"
  "$app/Voice/StepCodec.swift"
  "$app/Voice/CallTranscript.swift"
  "$app/Voice/PCM.swift"
  "$app/Voice/CallCore.swift"
  "$app/Voice/CallRules.swift"
  "$app/Voice/CallSession.swift"
  "$app/Voice/CallProblems.swift"
  # Make viewer bars in the page's colour (CSS colour parsing, dark / light) and the shell's long
  # edge fade
  "$app/Make/PageTint.swift"
  "$app/Theme/EdgeFade.swift"
  # M20 (pure Foundation): the approval card's Always row and the disabled Always line, and the
  # Make viewer's ask-before-leaving link rule
  "$app/Chat/Cards/ApprovalAlwaysRules.swift"
  "$app/Make/ExternalLinkRules.swift"
  # M20 (pure Foundation): OpenDuet's computer as an optional deploy, its sleep state and "Let it sleep"
  "$app/Computer/ComputerDeployRules.swift"
  # M21 (pure Foundation): icon-only tab bar with a 4th tab
  "$app/Shell/TabBarRule.swift"
  # M23 (pure Foundation): the Up next suggestion above the composer and the suggestion swipe, the
  # quick-reply card's rows, an approval's "why" and its Always row
  "$app/Chat/Composer/SuggestionRules.swift"
  "$app/Chat/Composer/QuickReplyRules.swift"
  "$app/Chat/Cards/ApprovalWhyRules.swift"
  # M24 (pure Foundation): the thumbnail disk cache, the viewer's Versions / Undo rows, the card's
  # line chart runs and the checkable checklist's ticks
  "$app/Make/ThumbnailDiskCache.swift"
  "$app/Make/VersionRules.swift"
  "$app/Chat/Cards/CardBlockRules.swift"
  # M25 W2 (pure Foundation): the skills page's Add skill menu, upload types / caps / failure lines,
  # Create with OpenDuet's prefill; the connectors page's Built in rows
  "$app/Settings/SkillAddRules.swift"
  "$app/Connectors/BuiltinConnectorsRules.swift"
  # M26 (pure Foundation): an HTML file preview below the header, its bottom inset
  "$app/Files/FilePreviewLayout.swift"
  # M26 W2 (pure Foundation): the Files page's groups by origin, the delete switch, query, refusal
  # lines and outcome
  "$app/Files/FileGroups.swift"
  "$app/Files/FileDeleteRules.swift"
  # M27 W4 (pure Foundation): live dashboard data (the HTML data-version reader, the hand-over
  # script, Share's refetch, one GET /data per artifact) and the thumbnails' 30 s pacing
  "$app/Make/LiveDataRules.swift"
  "$app/Make/ThumbnailPacing.swift"
  # M27 W5 (pure Foundation): the Voice page's rows (realtime section, key states, StepFun's region,
  # speech recognition), the provider forms' rows, the composer mic's recognizer and notes, the
  # transcription multipart body and the WAV recorder settings
  "$app/Networking/MultipartForm.swift"
  "$app/Settings/Models/ProviderRegionRules.swift"
  "$app/Settings/Voice/VoicePageRules.swift"
  "$app/Settings/Voice/VoiceDictationRules.swift"
  "$app/Chat/Composer/DictationRules.swift"
  "$app/Chat/Composer/CloudRecorderSettings.swift"
  # M27 W6 (pure Foundation): the full-screen view's tab strip and address bar (cleaned page
  # strings, the shown host, refusals, the queue and the stale-GET rule) and the landscape full
  # screen's block, margins and rotation rules
  "$app/Computer/BrowserBarRules.swift"
  "$app/Computer/FullScreenRules.swift"
  # M28 auth (pure Foundation): the model name for X-Device-Name and the headers every request
  # sends; the Signed-in devices page's rows, sections, error lines and the live computer's
  # socket-close rule
  "$app/Networking/DeviceModelName.swift"
  "$app/Networking/RequestContext.swift"
  "$app/Account/DevicesRules.swift"
  "$here/main.swift"
)

xcrun swiftc -swift-version 6 -module-name HostTests \
  -F "$frameworks" -plugin-path "$plugins" \
  -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libs" \
  "${sources[@]}" -o "$out/host-tests"

"$out/host-tests" "$@"
