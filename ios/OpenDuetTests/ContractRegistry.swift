// Maps every name in backend/src/contract/index.ts `contractShapes` to its Swift model.
// A new contract shape needs a line here and a sample in docs/api-samples/.
import Foundation
#if canImport(OpenDuet)
@testable import OpenDuet
#endif

extension ContractSamples {
    static func registry() -> [String: Check] {
        var r: [String: Check] = [:]
        r["ApiError"] = response(ApiErrorBody.self)
        // auth
        r["ServerInfo"] = response(ServerInfo.self)
        r["SignInRequest"] = request(SignInRequest.self)
        r["SignInResponse"] = response(SignInResponse.self)
        r["Me"] = response(CurrentUser.self)
        r["UpdateMeRequest"] = request(UpdateMeRequest.self)
        r["OnboardingInfo"] = response(OnboardingInfo.self)
        r["OnboardingCompleteResponse"] = response(OnboardingCompleteResponse.self)
        // channels and files
        r["ChannelList"] = response(ChannelList.self)
        r["CreateChannelRequest"] = request(CreateChannelRequest.self)
        r["UpdateChannelRequest"] = request(UpdateChannelRequest.self)
        r["MarkReadRequest"] = request(MarkReadRequest.self)
        r["ChannelFileList"] = response(ChannelFileList.self)
        r["UploadFileResponse"] = response(UploadFileResponse.self)
        // messages
        r["MessagePage"] = response(MessagePage.self) { page, report in record(page.messages, &report) }
        r["SendMessageRequest"] = request(SendMessageRequest.self)
        r["MessageActionRequest"] = request(MessageActionRequest.self)
        r["MessageActionResponse"] = response(MessageActionResponse.self) { value, report in record([value.message], &report) }
        r["ReactionResponse"] = response(ReactionResponse.self) { value, report in record([value.message], &report) }
        r["FeedbackRequest"] = request(FeedbackRequest.self)
        r["StopResponse"] = response(StopResponse.self)
        // tasks, schedule, up next
        r["TaskList"] = response(TaskList.self)
        r["TaskDetail"] = response(TaskDetail.self)
        r["CreateTaskRequest"] = request(CreateTaskRequest.self)
        r["UpdateTaskRequest"] = request(UpdateTaskRequest.self)
        r["ScheduleInfo"] = response(ScheduleInfo.self)
        r["RunNowRequest"] = request(RunNowRequest.self)
        r["RunNowResponse"] = response(RunNowResponse.self)
        r["RoutineRuns"] = response(RoutineRuns.self)
        r["UpNext"] = response(UpNext.self)
        r["AddSuggestionResponse"] = response(AddSuggestionResponse.self)
        // approvals
        r["ApprovalDecisionRequest"] = request(ApprovalDecisionRequest.self)
        r["ApprovalDecisionResponse"] = response(ApprovalDecisionResponse.self)
        // events
        r["DuetEvent"] = response(DuetEvent.self) { event, report in record(event, &report) }
        // connectors
        r["ConnectorList"] = response(ConnectorList.self)
        r["ConnectorDetail"] = response(ConnectorDetail.self)
        r["ConnectResponse"] = response(ConnectResponse.self)
        r["UpdatePolicyRequest"] = request(UpdatePolicyRequest.self)
        // account
        r["UsageState"] = response(UsageState.self)
        r["UsageStats"] = response(UsageStats.self)
        r["MemoryState"] = response(MemoryState.self)
        r["UpdateMemoryRequest"] = request(UpdateMemoryRequest.self)
        r["RegisterDeviceRequest"] = request(RegisterDeviceRequest.self)
        r["RegisterDeviceResponse"] = response(RegisterDeviceResponse.self)
        r["SkillList"] = response(SkillList.self)
        r["CreateSkillRequest"] = request(CreateSkillRequest.self)
        // artifacts
        r["ArtifactList"] = response(ArtifactList.self)
        r["ArtifactDetail"] = response(ArtifactDetail.self)
        r["CreateArtifactRequest"] = request(CreateArtifactRequest.self)
        r["EditArtifactRequest"] = request(EditArtifactRequest.self)
        r["UpdateArtifactRequest"] = request(UpdateArtifactRequest.self)
        r["ArtifactResponse"] = response(ArtifactResponse.self)
        // computer
        r["ComputerState"] = response(ComputerState.self)
        r["ComputerControlResponse"] = response(ComputerControlResponse.self)
        r["SignInCardRequest"] = request(SignInCardRequest.self)
        r["SignInCardResponse"] = response(SignInCardResponse.self)
        r["ComputerClientMessage"] = request(ComputerClientMessage.self)
        r["ComputerServerMessage"] = response(ComputerServerMessage.self)
        // run records (M8)
        r["RunList"] = response(RunList.self)
        r["RunDetail"] = response(RunDetail.self)
        // M11: soul, memory layers, access, skills, custom connectors
        r["Soul"] = response(Soul.self)
        r["UpdateSoulRequest"] = request(UpdateSoulRequest.self)
        r["ChannelMemoryState"] = response(ChannelMemoryState.self)
        r["CreateMemoryFactRequest"] = request(CreateMemoryFactRequest.self)
        r["UpdateMemoryFactRequest"] = request(UpdateMemoryFactRequest.self)
        r["MemoryFactResponse"] = response(MemoryFactResponse.self)
        r["MemoryOverview"] = response(MemoryOverview.self)
        r["ChannelAccess"] = response(ChannelAccess.self)
        r["UpdateChannelAccessRequest"] = request(UpdateChannelAccessRequest.self)
        r["UpdateAccessScopeRequest"] = request(UpdateAccessScopeRequest.self)
        r["Skill"] = response(Skill.self)
        r["UpdateSkillRequest"] = request(UpdateSkillRequest.self)
        r["SkillFileContent"] = response(SkillFileContent.self)
        r["SkillImportPreview"] = response(SkillImportPreview.self)
        r["SkillImportRequest"] = request(SkillImportRequest.self)
        r["CustomConnectorList"] = response(CustomConnectorList.self)
        r["CreateCustomConnectorRequest"] = request(CreateCustomConnectorRequest.self)
        r["UpdateCustomConnectorRequest"] = request(UpdateCustomConnectorRequest.self)
        r["CustomConnectorResponse"] = response(CustomConnectorResponse.self)
        r["ConnectRequestSubmit"] = request(ConnectRequestSubmit.self)
        // M12: providers, models, defaults
        r["ModelsState"] = response(ModelsState.self)
        r["ModelProviderResponse"] = response(ModelProviderResponse.self)
        r["CreateModelProviderRequest"] = request(CreateModelProviderRequest.self)
        r["UpdateModelProviderRequest"] = request(UpdateModelProviderRequest.self)
        r["RemoteModelList"] = response(RemoteModelList.self)
        r["CreateModelEntryRequest"] = request(CreateModelEntryRequest.self)
        r["CreateModelEntriesRequest"] = request(CreateModelEntriesRequest.self)
        r["UpdateModelEntryRequest"] = request(UpdateModelEntryRequest.self)
        r["ModelEntryResponse"] = response(ModelEntryResponse.self)
        r["UpdateModelDefaultsRequest"] = request(UpdateModelDefaultsRequest.self)
        // M13: realtime voice
        r["StartCallRequest"] = request(StartCallRequest.self)
        r["StartCallResponse"] = response(StartCallResponse.self)
        r["CallLinesRequest"] = request(CallLinesRequest.self)
        r["CallToolRequest"] = request(CallToolRequest.self)
        r["CallToolResponse"] = response(CallToolResponse.self)
        r["EndCallRequest"] = request(EndCallRequest.self)
        r["CallDetail"] = response(CallDetail.self) { detail, report in record(detail.messages, &report) }
        r["VoiceSettings"] = response(VoiceSettings.self)
        r["UpdateVoiceSettingsRequest"] = request(UpdateVoiceSettingsRequest.self)
        // M27 voice: cloud dictation's answer (region, presets and dictation ride on the shapes above)
        r["TranscriptionResponse"] = response(TranscriptionResponse.self)
        // M17: connector templates, installs, remote MCP sign-in, pasted configs
        r["ConnectorTemplateList"] = response(ConnectorTemplateList.self)
        r["InstallTemplateRequest"] = request(InstallTemplateRequest.self)
        r["InstallTemplateResponse"] = response(InstallTemplateResponse.self)
        r["OAuthStartResponse"] = response(OAuthStartResponse.self)
        r["OAuthFinishRequest"] = request(OAuthFinishRequest.self)
        r["ImportConnectorsRequest"] = request(ImportConnectorsRequest.self)
        r["ImportConnectorsResponse"] = response(ImportConnectorsResponse.self)
        // M18: a done task's result in the chat (TextPayload.taskResult)
        r["TaskResult"] = response(TaskResultInfo.self)
        // M20: safety (sign-in code step, browser approvals, Always scopes)
        r["SignInCodeRequest"] = request(SignInCodeRequest.self)
        r["BrowserAction"] = response(BrowserAction.self)
        r["ApprovalAlways"] = response(ApprovalAlways.self)
        // M21: reliability (the running turn, Make edit / refresh status)
        r["ActiveRun"] = response(ActiveRun.self)
        r["ArtifactWorkStatus"] = response(ArtifactWorkStatus.self)
        // M22: what a task needs, Needs you, Setup, "who OpenDuet is" in the chat
        r["TaskNextStep"] = response(TaskNextStep.self)
        r["TaskFailure"] = response(TaskFailure.self)
        r["NeedsYou"] = response(NeedsYou.self)
        r["SaveForLaterRequest"] = request(CreateTaskRequest.self)
        r["SaveForLaterResponse"] = response(SaveForLaterResponse.self)
        r["SetupInfo"] = response(SetupInfo.self)
        r["SoulIntroResponse"] = response(SoulIntroResponse.self)
        // M23: background-write sources, the brief's unchecked sources
        r["SourceRef"] = response(SourceRef.self)
        r["BriefInfo"] = response(BriefInfo.self)
        // M24: artifact versions and restore (undo), the card's line chart
        r["ArtifactVersionList"] = response(ArtifactVersionList.self)
        r["RestoreArtifactRequest"] = request(RestoreArtifactRequest.self)
        r["LineChartBlock"] = response(CardBlock.self) { block, report in
            if case .lineChart = block { return }
            report.errors.append("LineChartBlock decoded as \(block), not lineChart")
        }
        // M25: the built-in key-less connectors (skills ride on Skill / SkillImportPreview)
        r["BuiltinConnectorList"] = response(BuiltinConnectorList.self)
        // M26: deleting a file, also a sent one (the rows' new fields ride on ChannelFile)
        r["DeleteFileRequest"] = request(DeleteFileRequest.self)
        r["DeleteFileResponse"] = response(DeleteFileResponse.self) { value, report in
            if let message = value.message { record([message], &report) }
        }
        // M27 A: live dashboard data (the data fetch; update_artifact_data's arguments and result as run
        // records show them; the summary / version fields ride on ArtifactSummary / ArtifactVersion)
        r["ArtifactDataResponse"] = response(ArtifactDataResponse.self)
        r["UpdateArtifactDataInput"] = response(UpdateArtifactDataInput.self)
        r["UpdateArtifactDataResult"] = response(UpdateArtifactDataResult.self)
        // M27 browser: the full-screen view's own tab strip and address bar (the stream's
        // browser_bar rides on ComputerServerMessage)
        r["BrowserBar"] = response(BrowserBar.self)
        r["NewTabRequest"] = request(NewTabRequest.self)
        r["NavigateRequest"] = request(NavigateRequest.self)
        // M28: signed-in devices and signing out the others
        r["SessionList"] = response(SessionList.self)
        r["RevokeOtherSessionsResponse"] = response(RevokeOtherSessionsResponse.self)
        return r
    }
}

// Exhaustive switches: a new case in the app's enums fails to compile here until it is mapped.
extension MessageContent {
    var sampleKind: String {
        switch self {
        case .text: "text"
        case .file: "file"
        case .image: "image"
        case .taskSpawn: "task_spawn"
        case .taskSuggestions: "task_suggestions"
        case .proactiveSuggestion: "proactive_suggestion"
        case .quickReplies: "quick_replies"
        case .approval: "approval"
        case .spendRequest: "spend_request"
        case .confirmation: "confirmation"
        case .alert: "alert"
        case .plate: "plate"
        case .system: "system"
        case .usageLimit: "usage_limit"
        case .artifact: "artifact"
        case .liveBrowser: "live_browser"
        case .signIn: "sign_in"
        case .skillProposal: "skill_proposal"
        case .form: "form"
        case .card: "card"
        case .memoryNote: "memory_note"
        case .soulProposal: "soul_proposal"
        case .connectionRequest: "connection_request"
        case .modelError: "model_error"
        case .call: "call"
        case .soulSetup: "soul_setup"
        case let .unsupported(kind): kind
        }
    }
}

extension DuetEvent.Body {
    var sampleType: String {
        switch self {
        case .status: "status"
        case .typing: "typing"
        case .message: "message"
        case .messageDeleted: "message_deleted"
        case .task: "task"
        case .approval: "approval"
        case .channel: "channel"
        case .artifact: "artifact"
        case .usage: "usage"
        case .computer: "computer"
        case .notification: "notification"
        case .done: "done"
        case .taskDeleted: "task_deleted"
        case .channelDeleted: "channel_deleted"
        case .call: "call"
        case .resync: "resync"
        case let .unsupported(type): type
        }
    }
}
