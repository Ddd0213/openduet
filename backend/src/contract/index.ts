// The API contract: re-exports every schema and names the shapes that have samples in
// docs/api-samples/. Each sample file maps schema names (keys of `contractShapes`) to one
// example object or an array of examples; test/contract.test.ts validates them all, and
// the app's ContractSamplesTests decode the same files into its Codable models.
import * as account from "./account.ts";
import * as approvals from "./approvals.ts";
import * as artifacts from "./artifacts.ts";
import * as auth from "./auth.ts";
import * as channels from "./channels.ts";
import * as common from "./common.ts";
import * as computer from "./computer.ts";
import * as connectors from "./connectors.ts";
import * as events from "./events.ts";
import * as m11 from "./m11.ts";
import * as m12 from "./m12.ts";
import * as m13 from "./m13.ts";
import * as m17 from "./m17.ts";
import * as m18 from "./m18.ts";
import * as m20 from "./m20.ts";
import * as m21 from "./m21.ts";
import * as m22 from "./m22.ts";
import * as m23 from "./m23.ts";
import * as m24 from "./m24.ts";
import * as m25 from "./m25.ts";
import * as m26 from "./m26.ts";
import * as m27 from "./m27.ts";
import * as m27voice from "./m27voice.ts";
import * as m27browser from "./m27browser.ts";
import * as m28 from "./m28.ts";
import * as messages from "./messages.ts";
import * as runs from "./runs.ts";
import * as tasks from "./tasks.ts";

export * from "./account.ts";
export * from "./approvals.ts";
export * from "./artifacts.ts";
export * from "./auth.ts";
export * from "./channels.ts";
export * from "./common.ts";
export * from "./computer.ts";
export * from "./connectors.ts";
export * from "./events.ts";
export * from "./m11.ts";
export * from "./m12.ts";
export * from "./m13.ts";
export * from "./m17.ts";
export * from "./m18.ts";
export * from "./m20.ts";
export * from "./m21.ts";
export * from "./m22.ts";
export * from "./m23.ts";
export * from "./m24.ts";
export * from "./m25.ts";
export * from "./m26.ts";
export * from "./m27.ts";
export * from "./m27voice.ts";
export * from "./m27browser.ts";
export * from "./m28.ts";
export * from "./messages.ts";
export * from "./runs.ts";
export * from "./tasks.ts";

/** Every request/response/event shape that crosses the wire. */
export const contractShapes = {
  ApiError: common.ApiError,
  // auth
  ServerInfo: auth.ServerInfo,
  SignInRequest: auth.SignInRequest,
  SignInResponse: auth.SignInResponse,
  Me: auth.Me,
  UpdateMeRequest: auth.UpdateMeRequest,
  OnboardingInfo: auth.OnboardingInfo,
  OnboardingCompleteResponse: auth.OnboardingCompleteResponse,
  // channels and files
  ChannelList: channels.ChannelList,
  CreateChannelRequest: channels.CreateChannelRequest,
  UpdateChannelRequest: channels.UpdateChannelRequest,
  MarkReadRequest: channels.MarkReadRequest,
  ChannelFileList: channels.ChannelFileList,
  UploadFileResponse: messages.UploadFileResponse,
  // messages
  MessagePage: messages.MessagePage,
  SendMessageRequest: messages.SendMessageRequest,
  MessageActionRequest: messages.MessageActionRequest,
  MessageActionResponse: messages.MessageActionResponse,
  ReactionResponse: messages.ReactionResponse,
  FeedbackRequest: messages.FeedbackRequest,
  StopResponse: messages.StopResponse,
  // tasks, schedule, up next
  TaskList: tasks.TaskList,
  TaskDetail: tasks.TaskDetail,
  CreateTaskRequest: tasks.CreateTaskRequest,
  UpdateTaskRequest: tasks.UpdateTaskRequest,
  ScheduleInfo: tasks.ScheduleInfo,
  RunNowRequest: tasks.RunNowRequest,
  RunNowResponse: tasks.RunNowResponse,
  RoutineRuns: tasks.RoutineRuns,
  UpNext: tasks.UpNext,
  AddSuggestionResponse: tasks.AddSuggestionResponse,
  // approvals
  ApprovalDecisionRequest: approvals.ApprovalDecisionRequest,
  ApprovalDecisionResponse: approvals.ApprovalDecisionResponse,
  // events
  DuetEvent: events.DuetEvent,
  // connectors
  ConnectorList: connectors.ConnectorList,
  ConnectorDetail: connectors.ConnectorDetail,
  ConnectResponse: connectors.ConnectResponse,
  UpdatePolicyRequest: connectors.UpdatePolicyRequest,
  // account
  UsageState: account.UsageState,
  UsageStats: account.UsageStats,
  MemoryState: account.MemoryState,
  UpdateMemoryRequest: account.UpdateMemoryRequest,
  RegisterDeviceRequest: account.RegisterDeviceRequest,
  RegisterDeviceResponse: account.RegisterDeviceResponse,
  SkillList: account.SkillList,
  CreateSkillRequest: account.CreateSkillRequest,
  // artifacts
  ArtifactList: artifacts.ArtifactList,
  ArtifactDetail: artifacts.ArtifactDetail,
  CreateArtifactRequest: artifacts.CreateArtifactRequest,
  EditArtifactRequest: artifacts.EditArtifactRequest,
  UpdateArtifactRequest: artifacts.UpdateArtifactRequest,
  ArtifactResponse: artifacts.ArtifactResponse,
  // computer
  ComputerState: computer.ComputerState,
  ComputerControlResponse: computer.ComputerControlResponse,
  SignInCardRequest: computer.SignInCardRequest,
  SignInCardResponse: computer.SignInCardResponse,
  ComputerClientMessage: computer.ComputerClientMessage,
  ComputerServerMessage: computer.ComputerServerMessage,
  // run records
  RunList: runs.RunList,
  RunDetail: runs.RunDetail,
  // M11: soul, memory layers, access, skills, custom connectors
  Soul: m11.Soul,
  UpdateSoulRequest: m11.UpdateSoulRequest,
  ChannelMemoryState: m11.ChannelMemoryState,
  CreateMemoryFactRequest: m11.CreateMemoryFactRequest,
  UpdateMemoryFactRequest: m11.UpdateMemoryFactRequest,
  MemoryFactResponse: m11.MemoryFactResponse,
  MemoryOverview: m11.MemoryOverview,
  ChannelAccess: m11.ChannelAccess,
  UpdateChannelAccessRequest: m11.UpdateChannelAccessRequest,
  UpdateAccessScopeRequest: m11.UpdateAccessScopeRequest,
  Skill: account.Skill,
  UpdateSkillRequest: account.UpdateSkillRequest,
  SkillFileContent: m11.SkillFileContent,
  SkillImportPreview: m11.SkillImportPreview,
  SkillImportRequest: m11.SkillImportRequest,
  CustomConnectorList: m11.CustomConnectorList,
  CreateCustomConnectorRequest: m11.CreateCustomConnectorRequest,
  UpdateCustomConnectorRequest: m11.UpdateCustomConnectorRequest,
  CustomConnectorResponse: m11.CustomConnectorResponse,
  ConnectRequestSubmit: m11.ConnectRequestSubmit,
  // M12: model configuration
  ModelsState: m12.ModelsState,
  ModelProviderResponse: m12.ModelProviderResponse,
  CreateModelProviderRequest: m12.CreateModelProviderRequest,
  UpdateModelProviderRequest: m12.UpdateModelProviderRequest,
  RemoteModelList: m12.RemoteModelList,
  CreateModelEntryRequest: m12.CreateModelEntryRequest,
  CreateModelEntriesRequest: m12.CreateModelEntriesRequest,
  UpdateModelEntryRequest: m12.UpdateModelEntryRequest,
  ModelEntryResponse: m12.ModelEntryResponse,
  UpdateModelDefaultsRequest: m12.UpdateModelDefaultsRequest,
  // M13: realtime voice
  StartCallRequest: m13.StartCallRequest,
  StartCallResponse: m13.StartCallResponse,
  CallLinesRequest: m13.CallLinesRequest,
  CallToolRequest: m13.CallToolRequest,
  CallToolResponse: m13.CallToolResponse,
  EndCallRequest: m13.EndCallRequest,
  CallDetail: m13.CallDetail,
  VoiceSettings: m13.VoiceSettings,
  UpdateVoiceSettingsRequest: m13.UpdateVoiceSettingsRequest,
  // M27 voice: cloud dictation's answer (region, presets and dictation ride on the shapes above)
  TranscriptionResponse: m27voice.TranscriptionResponse,
  // M17: connector templates, one-tap installs, remote MCP sign-in, pasted configs
  ConnectorTemplateList: m17.ConnectorTemplateList,
  InstallTemplateRequest: m17.InstallTemplateRequest,
  InstallTemplateResponse: m17.InstallTemplateResponse,
  OAuthStartResponse: m17.OAuthStartResponse,
  OAuthFinishRequest: m17.OAuthFinishRequest,
  ImportConnectorsRequest: m17.ImportConnectorsRequest,
  ImportConnectorsResponse: m17.ImportConnectorsResponse,
  // M18: a done task's result in the chat (on TextMessage.payload.taskResult)
  TaskResult: m18.TaskResult,
  // M20: safety (sign-in code step, browser approvals, Always scopes, the optional computer)
  SignInCodeRequest: m20.SignInCodeRequest,
  BrowserAction: m20.BrowserAction,
  ApprovalAlways: m20.ApprovalAlways,
  // M21: reliability (the running turn, resync, Make edit / refresh status)
  ActiveRun: m21.ActiveRun,
  ArtifactWorkStatus: m21.ArtifactWorkStatus,
  // M22: tasks say what they need, Needs you, Setup, "who OpenDuet is" in the chat
  TaskNextStep: m22.TaskNextStep,
  TaskFailure: m22.TaskFailure,
  NeedsYou: tasks.NeedsYou,
  SaveForLaterRequest: tasks.SaveForLaterRequest,
  SaveForLaterResponse: tasks.SaveForLaterResponse,
  SetupInfo: m22.SetupInfo,
  SoulIntroResponse: m22.SoulIntroResponse,
  // M23: where background writes came from, the brief's unchecked sources
  SourceRef: m23.SourceRef,
  BriefInfo: m23.BriefInfo,
  // M24: artifact versions (list, restore = undo), the card's line chart
  ArtifactVersionList: m24.ArtifactVersionList,
  RestoreArtifactRequest: m24.RestoreArtifactRequest,
  LineChartBlock: m24.LineChartBlock,
  // M25: the built-in key-less connectors (the skills' changes ride on Skill / SkillImportPreview;
  // the built-in skill manifest is server only and checked by its own test)
  BuiltinConnectorList: m25.BuiltinConnectorList,
  // M26: deleting a file, also a sent one (its rows' new fields ride on ChannelFile)
  DeleteFileRequest: m26.DeleteFileRequest,
  DeleteFileResponse: messages.DeleteFileResponse,
  // M27 A: live dashboard data (GET /api/artifacts/:id/data; update_artifact_data's arguments and result,
  // which the app sees in run records; the summary / version fields ride on ArtifactSummary / ArtifactVersion)
  ArtifactDataResponse: m27.ArtifactDataResponse,
  UpdateArtifactDataInput: m27.UpdateArtifactDataInput,
  UpdateArtifactDataResult: m27.UpdateArtifactDataResult,
  // M27 browser: the app's own tab strip and address bar (the stream's browser_bar message rides on
  // ComputerServerMessage)
  BrowserBar: m27browser.BrowserBar,
  NewTabRequest: m27browser.NewTabRequest,
  NavigateRequest: m27browser.NavigateRequest,
  // M28: signed-in devices (GET /api/sessions; one SessionInfo per session) and signing out the others
  SessionList: m28.SessionList,
  RevokeOtherSessionsResponse: m28.RevokeOtherSessionsResponse,
} as const;

export type ContractShapeName = keyof typeof contractShapes;
