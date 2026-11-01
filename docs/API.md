# OpenDuet API

Contract between the backend (`backend/`) and the iOS app (`ios/`). The zod schemas in
`backend/src/contract/` are the source of truth; every shape named below has a sample in
`docs/api-samples/` (file → `{ "<ShapeName>": sample | [samples] }`), checked by
`backend/test/contract.test.ts` and decoded by the app's `ContractSamplesTests`.

## Conventions

- JSON, camelCase keys. Timestamps are ISO 8601 strings (`2026-10-25T08:47:00.000Z`); the app formats them in its locale and the iPhone's 12/24-hour setting. Clock times and schedules are structured (`{ hour, minute }`, `Schedule`), never preformatted.
- Money is an integer in minor units plus an ISO currency code; the app formats it.
- Every request except `GET /api/server-info` and `POST /api/session` needs `Authorization: Bearer <token>` (also on SSE and the WebSocket).
- Every request sends `X-Timezone` (IANA, `TimeZone.current`) and `X-Locale` (`en` | `zh-Hans`); the backend keeps `User.timezone` / `User.language` in sync from them. M25: also `X-Region` (two letters) for `User.region`, see M25. M28: also `X-Device-Name` (the device's model name, printable ASCII, 1–64 characters, sign-in included) for the signed-in devices list, see M28 sessions.
- Errors: non-2xx with `ApiError` `{ error: { code, message, field? } }`. The app maps `code` to localized text. Codes: `unauthorized`, `invalid_credentials` (always "Wrong username or password."), `rate_limited`, `validation_failed`, `not_found`, `stale_version`, `expired`, `too_large`, `unsupported_type`, `not_configured`, `usage_limited`, `conflict` (M9: a routine's Run now while one of its runs is queued or running; M10: Stop when nothing is running or queued), `internal`. M26 adds `protected_path` and `computer_unreachable` (file delete; see M26).
- Request bodies: `POST /api/session` is capped at 16 KiB before parsing or rate limiting; other non-upload `/api/*` bodies at 6 MiB (skills JSON supports a 5 MiB folder). Oversized bodies return 413 `request_too_large` in the `ApiError` shape. Files allow 25 MiB, skills ZIP/upload 20 MiB, WAV transcription 8 MiB, each with 64 KiB multipart framing; these retain 413 `too_large`. Bun and Caddy have an outer 30 MiB cap; rejection at that transport/edge layer may not be JSON. Highly escaped JSON must also fit the byte cap.
- `Phrase` = server-built text as `{ key, params }` (rendered by the app from its String Catalog, keys listed in `backend/src/i18n/en.json` → `phrases`) or model-written text as `{ text }`. Param types: `text`, `number`, `datetime`, `relative_datetime`, `duration`. Placeholders in catalog strings are `{name}`.
- M29 compatibility: the protocol value `"claude"` is the M28-and-earlier spelling of `"assistant"`. The server reads it and accepts it in request inputs as `"assistant"`, while every write and response uses `"assistant"`. The old voice tool names `send_to_claude`, `claude_status` and `stop_claude` are accepted for calls already in progress and mapped to `send_to_assistant`, `assistant_status` and `stop_assistant`; new tool lists and instructions use only the new names.
- In-app links in markdown and resources: `duet://tasks/<id>`, `duet://artifacts/<id>`, `duet://channels/<id>`, `duet://files/<id>`, `duet://computer`. OAuth callback: `duet://oauth` (M17 remote MCP sign-in: `duet://oauth/callback`).
- Status pill keys: `StatusKey` in `contract/common.ts`.

## Routes

| Method | Path | Request | Response |
|---|---|---|---|
| GET | /api/server-info | – (no auth) | ServerInfo |
| POST | /api/session | SignInRequest (no auth, rate-limited) | SignInResponse |
| DELETE | /api/session | – | 204 (revokes the session) |
| GET | /api/sessions | – | SessionList (the signed-in devices, this one first) (M28) |
| DELETE | /api/sessions/:id | – | 204 (signs that device out; the current session 400 `validation_failed`, use DELETE /api/session) (M28) |
| POST | /api/sessions/revoke-others | – | RevokeOtherSessionsResponse (signs out every other device) (M28) |
| GET | /api/me | – | Me |
| PATCH | /api/me | UpdateMeRequest | Me |
| GET | /api/onboarding | – | OnboardingInfo |
| POST | /api/onboarding/complete | – | OnboardingCompleteResponse (welcome + first-day scan arrive as events) |
| GET | /api/events | `Last-Event-ID` or `?since=` | SSE of DuetEvent |
| GET | /api/channels | `?archived=true` | ChannelList |
| POST | /api/channels | CreateChannelRequest | Channel (+ Claude's hello as events) |
| PATCH | /api/channels/:id | UpdateChannelRequest | Channel |
| DELETE | /api/channels/:id | – | 204; the main thread 400 `validation_failed` (M9) |
| POST | /api/channels/:id/read | MarkReadRequest | 204 |
| GET | /api/channels/:id/messages | `?before=<messageId>&limit=50` | MessagePage |
| POST | /api/channels/:id/messages | SendMessageRequest | SSE of DuetEvent until `done` |
| POST | /api/channels/:id/stop | – | StopResponse (Stop: the channel's own chat turn; 409 `conflict` when none runs) (M10) |
| POST | /api/channels/:id/files | multipart `file` (≤ 25 MB, real type checked) | UploadFileResponse |
| GET | /api/channels/:id/files | – | ChannelFileList (newest first; M26: deleted files left out) |
| GET | /api/files/:id/content | – | the bytes (real `Content-Type`, `Content-Disposition` with the file name) |
| DELETE | /api/files/:id | `?alsoWorkspace=` or DeleteFileRequest (optional) | DeleteFileResponse, also for a sent file (M26; before: 204 only while not yet sent) |
| POST | /api/messages/:id/action | MessageActionRequest | MessageActionResponse |
| PUT / DELETE | /api/messages/:id/reactions/:emoji | – | ReactionResponse |
| POST | /api/feedback | FeedbackRequest | 204 (+ "Thanks for the feedback" line as an event) |
| GET | /api/tasks | `?channelId=<id>` (omit = Everything) | TaskList |
| POST | /api/tasks | CreateTaskRequest | TaskDetail |
| GET | /api/tasks/:id | – | TaskDetail |
| PATCH | /api/tasks/:id | UpdateTaskRequest | TaskDetail |
| DELETE | /api/tasks/:id | – | 204 (M9) |
| GET | /api/tasks/:id/messages | `?before=&limit=` | MessagePage (the task's own session) |
| POST | /api/tasks/:id/messages | SendMessageRequest | SSE until `done` |
| POST | /api/tasks/:id/stop | – | StopResponse (Stop: the task session's turn; 409 `conflict` when none runs) (M10) |
| POST | /api/tasks/:id/run | – | RunNowResponse (a routine's Run now; 409 `conflict` while one runs) (M9) |
| GET | /api/tasks/:id/runs | – | RoutineRuns (a routine's runs, newest first, ≤ 30) (M9) |
| GET | /api/runs | `?taskId=` or `?channelId=` (neither = every run), `&before=<runId>&limit=30` (1–100) | RunList (newest first) |
| GET | /api/runs/:id | – | RunDetail (steps oldest first, the newest 300 at most) |
| GET | /api/schedule | – | ScheduleInfo |
| POST | /api/schedule/run | RunNowRequest | RunNowResponse |
| GET | /api/up-next | – | UpNext |
| POST | /api/up-next/scan | – | 202 (results as events) |
| POST | /api/up-next/:id/add | – | AddSuggestionResponse |
| POST | /api/up-next/:id/hide | – | 204 |
| POST | /api/approvals/:id/approve | ApprovalDecisionRequest | ApprovalDecisionResponse, 409 `stale_version`, 410 `expired` |
| POST | /api/approvals/:id/decline | ApprovalDecisionRequest | ApprovalDecisionResponse |
| GET | /api/connectors | `?query=` | ConnectorList |
| GET | /api/connectors/:toolkit | – | ConnectorDetail |
| GET | /api/connectors/:toolkit/logo | – | image bytes |
| POST | /api/connectors/:toolkit/connect | – | ConnectResponse |
| DELETE | /api/connectors/:toolkit/accounts/:accountId | – | 204 (Disconnect) |
| PUT | /api/connectors/:toolkit/policy | UpdatePolicyRequest | ConnectorDetail |
| GET | /api/usage | – | UsageState |
| GET | /api/usage/stats | `?range=today\|7d\|30d\|all` (default 7d) | UsageStats (M9) |
| POST | /api/usage/full-reset | – | UsageState |
| GET | /api/memory | – | MemoryState |
| PUT | /api/memory | UpdateMemoryRequest | MemoryState |
| POST | /api/devices | RegisterDeviceRequest | RegisterDeviceResponse |
| DELETE | /api/devices/:id | – | 204 (on sign out) |
| GET | /api/skills | – | SkillList |
| POST | /api/skills | CreateSkillRequest | Skill |
| DELETE | /api/skills/:id | – | 204 |
| GET | /api/artifacts | – | ArtifactList |
| POST | /api/artifacts | CreateArtifactRequest | ArtifactResponse (build progress as `artifact` events) |
| GET | /api/artifacts/:id | – | ArtifactDetail |
| GET | /api/artifacts/:id/html | – | `text/html` (the app renders it with loadHTMLString) |
| POST | /api/artifacts/:id/refresh | – | ArtifactResponse |
| POST | /api/artifacts/:id/edit | EditArtifactRequest | ArtifactResponse |
| PATCH | /api/artifacts/:id | UpdateArtifactRequest | ArtifactResponse |
| DELETE | /api/artifacts/:id | – | 204 |
| GET | /api/artifacts/:id/data | – | ArtifactDataResponse (a dashboard's live data as stored; `json` null without data; not an "open") (M27) |
| GET | /api/computer | – | ComputerState |
| POST | /api/computer/take | – | ComputerControlResponse |
| POST | /api/computer/release | – | ComputerControlResponse (Claude takes a fresh snapshot and carries on) |
| POST | /api/computer/sign-in/:requestId | SignInCardRequest (body never logged) | SignInCardResponse |
| GET | /api/computer/tools | – | ConnectorDetail (the "Claude's computer" row: toolkit `duet_computer`, no accounts; `computer_exec` defaults to Ask, the other computer tools to Always) |
| PUT | /api/computer/policy | UpdatePolicyRequest (`tool` = a computer_* slug, or null for all) | ConnectorDetail |
| WS | /api/computer/stream | ComputerClientMessage (text frames) | binary JPEG frames + ComputerServerMessage. `Authorization: Bearer` on the upgrade (no query token). The first message is `state`; `frame_meta` precedes the first frame and any size change. Input is ignored unless this user has taken over. |
| GET / PUT | /api/soul | – / UpdateSoulRequest | Soul (M11) |
| GET / PUT | /api/channels/:id/memory | – / UpdateMemoryRequest | ChannelMemoryState (main thread 400) (M11) |
| POST | /api/memory/facts | CreateMemoryFactRequest | MemoryFactResponse (M11) |
| PATCH / DELETE | /api/memory/facts/:id | UpdateMemoryFactRequest / – | MemoryFactResponse / 204 (archives) (M11) |
| GET | /api/memory/overview | – | MemoryOverview (M11) |
| GET / PUT | /api/channels/:id/access | – / UpdateChannelAccessRequest | ChannelAccess (PUT on the main thread 400) (M11) |
| PUT | /api/access/scope | UpdateAccessScopeRequest | 204 (M11) |
| PATCH | /api/skills/:id | UpdateSkillRequest | Skill (M11) |
| GET | /api/skills/:id/files/*path | – | SkillFileContent (binary 400) (M11) |
| GET | /api/skills/:id/export | – | `application/zip` (M11) |
| GET | /api/skills/github/preview | `?url=` | SkillImportPreview (M11) |
| POST | /api/skills/zip/preview | multipart `file` (≤ 20 MB) | SkillImportPreview (M11) |
| POST | /api/skills/upload/preview | multipart `file`: a .zip / .skill (≤ 20 MB) or a SKILL.md (≤ 1 MB) | SkillImportPreview, source `upload` (M25) |
| POST | /api/skills/import | SkillImportRequest | SkillList (M11) |
| GET / POST | /api/custom-connectors | – / CreateCustomConnectorRequest | CustomConnectorList / CustomConnectorResponse (verified first) (M11) |
| PATCH / DELETE | /api/custom-connectors/:id | UpdateCustomConnectorRequest / – | CustomConnectorResponse / 204 (M11) |
| POST | /api/custom-connectors/:id/test | – | CustomConnectorResponse (M11) |
| PUT | /api/custom-connectors/:id/policy | UpdatePolicyRequest | CustomConnectorResponse (M11) |
| POST | /api/messages/:id/connect | ConnectRequestSubmit (values never stored or logged) | MessageActionResponse; 409 `conflict` when the card isn't open (M11) |
| GET | /api/models | – | ModelsState (runs the one-time import first) (M12) |
| POST | /api/providers | CreateModelProviderRequest (the key is never stored outside the vault) | ModelProviderResponse (verified first; 400 with the reason, nothing saved) (M12) |
| PATCH / DELETE | /api/providers/:id | UpdateModelProviderRequest / – | ModelProviderResponse (a new key / URL / auth / headers is verified again) / 204 (M12) |
| POST | /api/providers/:id/test | – | ModelProviderResponse (status and error updated) (M12) |
| GET | /api/providers/:id/remote-models | – | RemoteModelList (M12) |
| POST | /api/models | CreateModelEntryRequest | ModelEntryResponse; 409 when that provider already has that modelId (M12) |
| POST | /api/models/batch | CreateModelEntriesRequest | ModelsState (ids already added are skipped) (M12) |
| PATCH / DELETE | /api/models/:id | UpdateModelEntryRequest / – | ModelEntryResponse / 204 (M12) |
| PUT | /api/model-defaults | UpdateModelDefaultsRequest | ModelsState (M12) |
| GET / PUT | /api/voice-settings | – / UpdateVoiceSettingsRequest | VoiceSettings (M13; M27 adds providers, presets, dictation) |
| POST | /api/transcriptions | multipart `file` (WAV, 16-bit PCM, ≤ 8 MB, ≤ 120 s) + optional `language` | TranscriptionResponse `{text}` with the saved cloud recognizer (400 `not_configured`, 413 `too_large`, 415 `unsupported_type`, 502 `transcription_failed`) (M27 voice) |
| POST | /api/calls | StartCallRequest | StartCallResponse (the voice's credential, instructions and tools; 400 `not_configured` without a usable realtime model; 409 for an open call in another channel) (M13) |
| POST | /api/calls/:id/lines | CallLinesRequest | 204 (M13) |
| POST | /api/calls/:id/tool | CallToolRequest | CallToolResponse (M13) |
| POST | /api/calls/:id/end | EndCallRequest | MessageActionResponse (the call's `call` message; idempotent) (M13) |
| GET | /api/calls/:id | – | CallDetail (M13) |
| GET | /api/connector-templates | `?query=&cursor=` | ConnectorTemplateList (featured first without query / cursor; 502 `internal` when the MCP Registry can't be reached and nothing is cached) (M17) |
| POST | /api/connector-templates/install | InstallTemplateRequest | InstallTemplateResponse (400 `inputs.<name>` for a missing / unknown / bad input; 404 unknown template; 409 installed already with new values) (M17) |
| POST | /api/custom-connectors/import | ImportConnectorsRequest | ImportConnectorsResponse (remote entries added, the rest in `skipped`; 400 field `json`) (M17) |
| POST | /api/custom-connectors/:id/oauth/start | – | OAuthStartResponse (400 field `oauth` when sign-in can't start) (M17) |
| POST | /api/custom-connectors/:id/oauth/finish | OAuthFinishRequest | CustomConnectorResponse (410 `expired` field `state`; 400 field `code`) (M17) |
| DELETE | /api/custom-connectors/:id/oauth | – | CustomConnectorResponse (signed out, waits for sign-in again) (M17) |
| GET | /api/builtin-connectors | – | BuiltinConnectorList (M25) |

## SSE

`POST /api/channels/:id/messages` and `GET /api/events` send the same stored events:

```
id: 104
event: message
data: {"id":104,"type":"message","channelId":"ch_main","createdAt":"...","payload":{"message":{...}}}

: ping
```

- `id` is `Event.id`, increasing per server. Reconnect with `Last-Event-ID` (or `?since=`) to replay what was missed; the app dedups by id, so the POST stream and `/api/events` can overlap.
- A `: ping` comment goes out every ~20 s; responses carry `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- The POST stream starts with the user's own message (echoing `clientId`) and ends after `done` for that run. Types: see `DuetEvent` in `contract/events.ts` (`status`, `typing`, `message`, `message_deleted`, `task`, `approval`, `channel`, `artifact`, `usage`, `computer`, `notification`, `done`; M9: `task_deleted`, `channel_deleted`; M13: `call`).
- A failed run ends with `done` `{ status: "failed", error }` and a grey `system` message (e.g. `system.model_error`); the model never gets an invented reply.
- A background turn a module declines before it starts (today: over the usage limit) is stored as Run `skipped` and ends with `done` `{ status: "cancelled" }`.

## Route notes

- `GET /api/tasks?channelId=`: omitted, empty or `everything` = Everything; another user's channel is 404. Archived tasks are left out; pinned tasks first (newest pin first, M9), then newest `updatedAt` first.
- `POST /api/tasks` (the + sheet) answers 200 with `TaskDetail`; the task starts without a chip or a user message, the prompt is its first turn. A missing, archived or foreign channel is 404.
- `PATCH /api/tasks/:id` accepts `{ status?: "resolved", archived?: boolean }` (only the user resolves a task; replying to a resolved task reopens it) and, from M9, `pinned` (any task), `paused`, `schedule` (routines only, see M9 below) and `title` (any task from M10, see M10 below). Any other key is 400 `validation_failed`.
- Task done notice: when a task moves to `ready_for_review` (once per transition, not when it already was), Claude posts a normal `text` message to the task's channel (main timeline, `taskId` null) through the usual `message` event: `agent.task_done` in `User.language` (`Done: [<title>](duet://tasks/<id>)`) plus the `finish_task` summary when there is one. Push is unchanged. A decided approval no longer adds an outcome row to `TaskDetail.updates` (the run record shows it); `TaskUpdate.source` is `Claude`, `Claude's computer` or a connected app / toolkit name, anything else is stored as `Claude`.
- M16 merged updates: a server-built `TaskUpdate` (a phrase key) written right after the same one (same key, params and source; e.g. a retry that failed the same way) is merged into one row: optional `count` (≥ 2, how many times) and `since` (ISO, the first time); `at` is the latest. Model-written text is never merged. Rows without `count` happened once. `TaskSummary.updateCount` counts merged rows (stored rows from before M16 are merged when served). The app also merges older stored rows the same way, folds an approval row's arguments behind "Show details", renders model-written updates as markdown and shows the latest 8 rows until "Show N earlier".
- Quote reply: `SendMessageRequest.replyTo` (channel or task messages) is the id of one of Claude's messages in the same thread (the channel's timeline or that task's session); a user message, a missing id or one from another channel / task is 400 `validation_failed`, field `replyTo`. The stored user message carries `payload.replyTo` `{ messageId, role, excerpt }` (excerpt = the quoted text without markdown, first 160 characters); every other text message, and every older one, has `replyTo: null`. The model reads "The user is replying to this earlier message of yours: «excerpt»" before that turn.
- Run records (`GET /api/runs`, `GET /api/runs/:id`): one Run per chat, task, brief, check-in, scan, Make build and (M9) routine turn, with its steps: each tool call (`running`, then `ok` / `error` / `denied`, or `awaiting_approval` with `approvalId` until the card is decided and the step gets its final status and output), each reply-text segment (`text`), each thinking block (`thinking`) and a failure (`error`). `title` is a `run.step.*` key or `{ text }` (a connected app tool's display name); a run's `title` is the chat message's first 120 characters / the task's title as text, or `run.title.<kind>`. `?channelId=` lists that channel's own runs (chat, brief, check-in, scan, build); task runs are under `?taskId=`. A foreign task, channel or run is 404; a bad `limit` (outside 1–100) or an unknown `before` is 400 `validation_failed` with that field. No SSE: while a run is `queued` or `running` the app polls `GET /api/runs/:id` about every 2 s. Bodies are redacted (authorization headers; any name containing api key / secret / password / token / credentials, including env-style `DB_PASSWORD=` and compound JSON keys; `user:password@` in URLs; `Bearer …`, `sk-…` and other well-known key formats; the server's own keys) and capped: `input` / `output` 8 KB (a file the computer read 2 KB), `detail` 200 characters. Never stored: typed text (`computer_type` keeps only the field ref), written file contents (path + byte size), sign-in emails or passwords, images and other long base64 (data: URIs and line-wrapped too; shown as `[binary data]`). Steps of runs older than 30 days are deleted (at startup and daily); the run itself stays, with `stepCount` 0.
- Make from chat or a task: `make_artifact(type, title, prompt)` with type `doc` | `dashboard` | `web_page` | `slides` builds in the background (it replaced `make_doc`); the artifact card lands in the thread that asked. Dashboards use the base stylesheet's dashboard classes and the built-in, offline `duetBars` chart helper.
- `POST /api/messages/:id/action`: an action the card doesn't offer is 400 `validation_failed`; another user's message is 404. Repeating a start returns the card as it is (one task per item). A `skill_proposal` card takes `save_skill` (stores the Skill, state `saved` + `skillId`; a skill with that name is replaced) or `dismiss`; a decided card answers as it is.
- `POST /api/up-next/scan` answers 202 and runs the scan in the background; while one is already queued or running it is still 202 and nothing new starts. Over the usage limit it is 429 `usage_limited`. `GET /api/up-next`'s `scanning` covers only this scan, not the first-day scan.
- `POST /api/schedule/run` queues the run at once (`scheduledFor` null) and answers with its status (`queued` or `running`); over the usage limit 429 `usage_limited`, while shutting down 503. In `ScheduleInfo` history, a run cancelled by a restart shows as `skipped`.
- `POST /api/onboarding/complete` is idempotent: the first call returns `scanStarted: true` and queues the first-day scan; later calls return `scanStarted: false` and do nothing.
- `POST /api/usage/full-reset`: the month's reset already used (the month is the user's timezone) is 409 `stale_version`.
- `POST /api/feedback` with neither `rating` nor `text` is 400 `validation_failed`.
- `POST /api/channels` answers 200 with the `Channel`; Claude's hello with Yes / No / Not now arrives as events in the new channel.
- Push (NOTIFY_PROVIDER): every notification is a `notification` event; a remote push goes out only while the user has no live `GET /api/events` stream (M21: the POST /messages answer stream doesn't count). ntfy and bark carry only the title and the deep link (`route`); APNs carries the rendered text and `route`. Which runs push, the event's `passive` and the APNs badge: see M29 notify.
- `POST /api/artifacts` answers 200 with the `building` artifact; without Claude's computer it is 503 `not_configured` (nothing is stored), over the usage limit 429 `usage_limited`. Progress is `artifact` events: `buildStatus` goes `build.starting_up` → `build.waking_workspace` → the model's step lines (`{ text }`) → `null` when done (status `ready` or `failed`; a failure's reason is the last non-null `buildStatus` and a grey line in the thread). A build runs on its own queue, so the channel's chat isn't held up. A refresh or an edit keeps status `ready` (the old page stays readable) while `buildStatus` is non-null.
- `GET /api/artifacts/:id/html` is `text/html` with `Content-Security-Policy` (no network at all), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`; the same CSP is a `<meta>` in the page because the app renders it with `loadHTMLString`. For 60 s after an edit, changed elements carry `data-duet-changed` and the page's own CSS glows them for ~3 s.
- `POST /api/artifacts/:id/edit` with no page yet is 400 `validation_failed`. `PATCH /api/artifacts/:id` keeps `updatedAt` (content time); `pinnedToTabBar: true` on one artifact unpins the previous one from the tab bar (one 4th tab); `refreshSchedule: null` clears the schedule; `pinned` (M10) pins in Make, see M10 below.
- A `spend_request` card is decided through its `approvalId` (`POST /api/approvals/:approvalId/approve|decline` with `{ version: 1 }`); past `expiresAt` it turns `expired` and approve is 410 `expired`. Test mode: nothing is charged.
- Reactions: `PUT` is idempotent and only adds the user's own; `DELETE` removes only the user's own. The updated message arrives as a `message` event (upsert by id), also when Claude reacts.
- `GET /api/skills` lists the user's skills; `POST /api/skills` with an existing name replaces it. A message sent with `skill` (or starting with `/<name>`) gets that skill's instructions for its turn.
- Claude's computer has one owner per deployment: `COMPUTER_OWNER` (a username), or the first account. Any other account sees it as not set up: `GET /api/computer` is the off state (`available: false`), the other `/api/computer/*` routes and the WS upgrade are 503 `not_configured` (`/api/computer/tools` and `/policy` too, when a computer is configured), its Claude gets no computer or Make tools, and `POST /api/artifacts` is 503. `POST /api/computer/release` makes Claude take a fresh snapshot before it carries on (a task carries on in its own session; anything else carries on as a chat turn). A Make build never posts a live browser card or an approval card and isn't carried on after Take over; it ends and can be refreshed. In a build the user started (Create, ↻, ✎) the computer tools run without asking; in one Claude started (`make_artifact`, `edit_artifact`) or a scheduled refresh, tools set to Ask (by default `computer_exec`) are refused.
- `POST /api/computer/sign-in/:requestId`: the body is never logged, stored or given to the model; the backend types the email by ref and sends the password to the computer's `/human/secret`. An unknown or foreign request id is 404; one already delivered is 409 `stale_version`; a past one answers 200 `{ state: "expired" }`. The open page must still be the card's site, or nothing is typed and the card turns `expired`; a newer sign-in request also expires the older card (the computer holds one). A send that failed before the password was delivered (`state: "failed"`) can be retried until the card expires. Pending sign-in cards turn expired after a restart.
- `GET /api/files/:id/content` for HTML / SVG / XML adds `Content-Security-Policy: sandbox; default-src 'none'` (the app previews them in its own WKWebView).

## M9

Everything here is additive: old rows and old app builds keep working (new fields have defaults). Rules zod can't express are in `.pi/handoff/m9-contract.md`; the shapes are in `contract/`.

### Seen receipt

- A user message is `status: "sent"` (Delivered) once stored. It turns `"seen"` (a `message` update with the same id) only when the model starts answering that message's own turn: the first streamed text, thinking or tool call of the turn's first model call.
- A model call that fails before any event (gateway 4xx / 5xx, timeout, no provider) leaves it `"sent"`; the usual grey `system` line and `done` `{ status: "failed" }` follow.
- A message queued behind a running turn stays `"sent"` until its own turn starts answering (its `seen` update comes after the earlier run's `done`).

### Cards Claude writes: `form` and `card`

- `ask_form` posts a `form` message (`FormMessage`: title, description, icon, 1–8 fields `single` / `multi` / `text`, `allowOther`, `submitLabel`, `state: "open"`, `answers: null`). Field and option ids are the server's (`f1`, `f1o1`, ...). A dismissed form may carry optional `closedBy: "assistant"` when the assistant withdrew it; user Skip omits the field, and omitted legacy data means the user closed it. It ends Claude's turn; in a task's session the task becomes `needs_input`. Bad tool input never posts a card: the model gets a tool error and can try again.
- `show_card` posts a `card` message (`CardMessage`: icon, tint, title, subtitle, ≤ 8 blocks `text` / `rows` / `metrics` / `progress` / `checklist` / `bars`, ≤ 3 actions). The turn carries on. Actions: `send` sends `value` as the user's message; `open_url` is https only (in-app Safari sheet); `open_route` is a `duet://` route. The first action defaults to `primary`, the rest to `secondary`.
- `withdraw_card` is available in chat/channel and task turns. Its input is `{title?: string, all?: boolean}` with exactly one of a trimmed, case-insensitive `title` or `all: true`. It only finds open `form` and `connection_request` messages authored by the assistant in the current channel thread (`taskId: null`) or current task thread; it never touches approvals, sign-in, quick replies, user messages, other channels or tasks. Each claimed card becomes `state: "dismissed"` with `closedBy: "assistant"`, emits a `message` update, and task cards refresh `TaskSummary.nextStep`. The result has `withdrawn` and `remaining` title arrays; no match is successful and lists the remaining open titles. Approval cards cannot be withdrawn with this tool; they expire or the user declines.
- `CardIcon` has 38 keys, `CardTint` 7 (`common.ts`); the app decodes unknown ones to `sparkle` / `grey`. `task_suggestions` items carry `icon: CardIcon | null` (`propose_tasks` takes an optional `icon` per item; null and older rows = lightbulb).
- Submit: `POST /api/channels/:id/messages` (or `/api/tasks/:id/messages` for a task's form) with `SendMessageRequest` `{ text, clientId, form: { messageId, answers: [{ fieldId, optionIds, text }] } }`.
  - `text` is the app's summary, one `<label>: <answer>` line per answered question (multi joined with ", ", "Other" / text answers as typed). It is stored as the user's normal `text` message and runs a normal turn.
  - `FormAnswer.text` may be omitted (= null); blank text counts as no answer.
  - The card must be a `form` of this thread (the channel's timeline, or that task's session), else 400 `validation_failed`, field `form`. Every `fieldId` must exist, option ids must belong to their field, a `single` field takes exactly one option (or only typed text when `allowOther`), typed text needs `allowOther` (or a `text` field), a `text` field takes no options, no field twice, every `required` field answered; else 400 `validation_failed`, field `form`.
  - A card that is no longer `open` (submitted or skipped, also a second submit racing the first) is 409 `stale_version`, field `form`; nothing is stored.
  - On success the card becomes `state: "submitted"` with `answers` (in field order, empty ones dropped) through a `message` update. The model reads the turn's message as `Form "<title>" answered: <server summary>`, and later turns see the card as `[form "<title>" (answered)]`.
- Skip: `POST /api/messages/:id/action` `{ action: "dismiss" }` on an open form sets `state: "dismissed"` (a `message` update); no turn runs and nothing is posted. Skipping again answers the card as it is; a submitted form is 409 `stale_version`; any other action on a form is 400.

### Scheduled tasks (routines)

- A routine is a Task with `status: "scheduled"`, `schedule` (`Schedule`: `daily` / `weekdays` / `weekly` + `weekday` 0 = Sunday / `hourly` at `minute` / `once` + `at`) and `routine` `{ paused, quiet, nextRunAt, lastRunAt, lastRunStatus }`. Every other task has `routine: null`. Hours and minutes are the user's local time (`User.timezone`).
- Made in chat by `schedule_task(title, prompt, schedule, quiet?)` in the current channel (at most 50 per user); changed by `manage_scheduled_task(taskId, action: pause | resume | delete | update, title?, prompt?, schedule?, quiet?)`. Each chat turn lists up to 20 of the user's routines (id, title, schedule, paused) in its instructions.
- At each slot the scheduler (same tick as the built-ins, every 30 s) runs the routine's prompt as a background turn (Run kind `routine`, model role proactive, ~24 tool rounds) in the routine's channel; the result is posted there as Claude's messages (`taskId` null). A quiet routine's plain text is muted: it posts only through `post_message` or a card, and a run that posted nothing is Run `resolved`. Afterwards `lastRunAt` / `lastRunStatus` are set and a `task` event goes out. A `once` routine has `nextRunAt: null` after its run.
- Slots: `nextRunAt` moves on with a compare-and-set, and the Run's unique `slotKey` (`<taskId>:<slot ISO>`) claims the slot once, so two ticks or two processes never run it twice. After downtime a routine runs once for the latest missed slot, not for each; a slot found more than 2 h late is recorded as a `skipped` Run. A queued slot of a routine that was paused or archived before its turn started doesn't run (Run `skipped`); one whose routine was deleted is cancelled with it. Over the usage limit (when limits are on) the run is skipped.
- `PATCH /api/tasks/:id`: `pinned` works for any task; `paused` and `schedule` only for routines (else 400 `validation_failed` with that field); `title` was routines-only in M9 and works for any task from M10. A routine can't be `resolved` (400; pause or delete it). A bad schedule (e.g. `weekly` without `weekday`, `hour` outside 0–23, a past `once.at`) is 400, field `schedule`. Pausing clears `nextRunAt`; a resume or a new schedule sets it to the next slot from now.
- `POST /api/tasks/:id/run` (Run now): queues a run at once (`scheduledFor` null, the schedule doesn't move) → `RunNowResponse`; 409 `conflict` while one of its runs is queued or running; over the usage limit 429; not a routine 400; someone else's 404.
- `GET /api/tasks/:id/runs` → `RoutineRuns`: newest first, at most 30. `scheduledFor` is the slot (null for Run now); a run cancelled by a restart or a delete shows as `skipped`. Not a routine 400; someone else's 404. Routine runs are also in `GET /api/runs?taskId=` (not under `?channelId=`).
- Built-in brief and check-ins: on unless `PROACTIVE_BUILTINS=0` (or `false`) (M14b; before, off by default). Each user's proactivity level (`off` / `low` / `normal` / `high`: 0 / 1 / 3 / 5 messages a day), quiet hours (default 22:30–08:30 local; check-ins only) and "don't interrupt" rules gate the scheduled ones before any model call; "Run now", reminders and routines are never gated. Off: the scheduler runs neither, `GET /api/schedule` says `builtins: false` (the app hides both rows), and chat has no `set_weekends`. Routines and the one-time first-day scan run either way.

### Deletes and pins

- `DELETE /api/tasks/:id` → 204. Cancels the task's queued or running turns (its session, and a routine's runs) and waits for them, then deletes the task with its thread, its approvals and their cards, its Up next suggestions and its `task_spawn` chip. Emits `message_deleted` for each of those cards outside the task's thread, then `task_deleted { taskId }`. Run rows stay (usage history). Someone else's task is 404.
- `DELETE /api/channels/:id` → 204; the main thread is 400 `validation_failed` (field `id`), someone else's 404. Cancels every queued or running turn of the channel (chat, its tasks, builds, routines), moves its Make artifacts to the main thread (an `artifact` event each, `channelId` = main), and hard-deletes the channel with its messages, tasks, approvals, suggestions, reminders, spend requests and files (rows and bytes). Emits `task_deleted` for each of its tasks, then `channel_deleted { channelId }` (envelope `channelId` = the deleted channel). Run rows stay.
- `TaskSummary.pinned` (`Task.pinnedAt`): Active lists pinned tasks first, newest pin first; pinning an already pinned task keeps its pin time.

### Usage stats and limits

- `GET /api/usage/stats?range=today|7d|30d|all` (default `7d`; anything else 400 `validation_failed`, field `range`) → `UsageStats`, counted from the user's Run rows with tokens (input + output, every model the same way) created in `[since, until]`.
  - `since`: local midnight today / 6 days ago / 29 days ago in `User.timezone`; null for `all`. `until` = now.
  - `byModel`: most tokens first; `label` from models.json (the model id when it has none; `unknown` for runs without a model), `provider` = the run's provider id.
  - `byKind`: `chat`, `task`, `build`, `proactive` (brief, check-in, scan, routine), in that order, only kinds with runs.
  - `series`: oldest first, `bucket` `hour` (today, from local midnight up to the current hour; a DST day has 23 or 25), `day` (7 / 30 local days), `month` (from the first counted run's month).
  - `estimated` is true when any counted run's tokens were estimated.
- Token limits: `SESSION_TOKEN_LIMIT` and `WEEKLY_TOKEN_LIMIT` default to 0 = off. With 0 nothing is blocked and no `usage_limit` line is posted; `UsageState` still counts usage, with `limit: 0`. Set either (e.g. 3000000 / 30000000) to turn it on; the M2 behaviour then applies unchanged.

### Smaller rules

- Resource `app` (`add_resource`): kept only when it is a connected app or a catalog toolkit (by display name or slug, stored as the display name) or "Claude's computer"; anything else ("Claude", "[CL]", a file name) is stored as null. Rows stored before M9 are unchanged.
- Capability brief: the chat, task and proactive / routine system prompts start with a short "You run inside openduet" brief (the tools and what they render, `ask_form` for choices instead of "reply 1A 2B", `show_card` for structured info, Make artifacts, background tasks, `schedule_task`, Claude's computer, approvals for writes), then the existing language rules. A Make build gets only its first line. M21: right after the brief comes an "Environment" section generated from this server's real configuration (agent/environment.ts): where Claude runs, this turn's model label, Claude's computer (deployed or not, what persists, its programs from a probe, exec limits, network, browser mode and idle sleep), how to read the web with this turn's tools, what asks for approval under the user's ToolPolicy, and the tools offered; a Make build gets only its three computer lines.
- Artifact HTML: the base sets `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">` (a page's own viewport meta is dropped) and CSS that keeps pages at phone width: html / body `overflow-x: hidden`, `max-width: 100%`, `touch-action: pan-y`, `-webkit-text-size-adjust: 100%`; img / svg / canvas / video `max-width: 100%`; bare tables are wrapped in `.duet-table-wrap` and scroll inside it. Build prompts ask for layouts that fit 390 pt and never `100vw`.
- i18n (phrases): `run.title.routine`, `run.step.form`, `run.step.card`, `run.step.schedule` (en / zh-Hans).

## M10

Additive again: new fields have defaults (older payloads parse as before) and the one migration (`m10_artifact_pin`) only adds a nullable column. The contract is `.pi/handoff/m10-contract.md`.

### Stop responding

- `POST /api/channels/:id/stop` → `StopResponse` `{ stopped: 1 }`. Stops the current turn of the channel's own chat (Run kind `chat`, `taskId` null): the running one, else the first queued one. The channel's tasks, Make builds, routines, briefs, check-ins and scans are left alone. Nothing of that kind running or queued is 409 `conflict`; someone else's channel 404.
- `POST /api/tasks/:id/stop` → `StopResponse`. The same for the task's own session (its turns: the first turn, replies, carry-ons after an approval). A routine's channel runs aren't its session. Nothing running or queued there is 409 `conflict`; someone else's task 404.
- One turn per call: messages (or task replies) queued behind the stopped turn still run, in order, and are answered normally. A second Stop stops the next one.
- A running turn is aborted at once (the model stream is cancelled) and the route answers once it has ended (at most ~10 s), so the app has typing off and `done` by then. A turn that was still queued answers at once and ends `cancelled` when its queue reaches it, without calling the model.
- What the thread gets:
  - The text Claude already streamed stays as a normal `text` message: the same bubble (same id), a final `message` update with the full streamed text and `stopped: true`. Only the turn's last text bubble is marked; earlier bubbles of that turn (split at paragraph breaks) and finished cards stay as they were.
  - Nothing streamed yet: no message is posted (no grey line either).
  - `typing` goes false, `status` null, and the run ends with the usual `done` `{ status: "cancelled", error: null }`; the Run row is `cancelled`.
  - The user's message keeps its receipt: `seen` if the model had started answering, else `sent` (Delivered).
  - A stopped task turn is decided like one that ended: the task goes to `needs_input` (or `ready_for_review` after `finish_task`), with a `task` event before `done`. With a reply already queued behind it, it stays `working`.
- `Message.stopped` (every kind, default `false`): true only on a Claude `text` message cut short by Stop. Stored in the message payload (`"stopped": true`), no column.
- A delete (`DELETE /api/tasks/:id`, `DELETE /api/channels/:id`) or a server restart still cancels turns the M9 way; those never mark a message `stopped`.

### Pin an artifact in Make

- `Artifact.pinnedAt` (nullable). `ArtifactSummary.pinned` (default `false`) = `pinnedAt` is set. It is separate from `pinnedToTabBar`: any number of artifacts can be pinned, both can be true, and pinning one to the tab bar (which unpins the previous tab) never changes `pinned`.
- `PATCH /api/artifacts/:id` `{ pinned: true | false }` (in the same partial strict `UpdateArtifactRequest`): pinning an already pinned artifact keeps its pin time; unpinning clears it. `updatedAt` stays (content time). The change goes out as an `artifact` event, and artifact cards in chat show the new summary.
- `GET /api/artifacts`: pinned first (newest pin first), then `updatedAt` desc. The artifacts Claude sees in chat context use the same order.

### Rename any task

- `PATCH /api/tasks/:id` `{ title }` works for every task (it was routines-only in M9): trimmed, 1–200 characters, else 400 `validation_failed`, field `title`. A changed title emits the `task` event and updates the task's `task_spawn` chip in its channel (a `message` update), like other task changes; the same title again is a no-op.

## M11

The channel system. Additive: new fields have defaults, new tables are separate, and the one migration (`m11_channel_system`) only adds columns and tables. The contract is `.pi/handoff/m11-contract.md`; shapes in `backend/src/contract/m11.ts`.

### Soul (who Claude is)

- `GET /api/soul` → `Soul`. With no row yet: empty strings and `updatedAt: null` (empty = the default: name Claude, addressed by first name).
- `PUT /api/soul` (`UpdateSoulRequest`, strict, every field optional) → `Soul`. Writes only the given fields (trimmed); the first PUT creates the row; `""` goes back to the default. Over the limit (name 40, addressAs 80, identity 2000, persona 4000, tone 1000) or an unknown field is 400 `validation_failed` with the field.
- The prompt carries it after the capability brief, the Environment section and the language lines, quoted as the user's own description (never above the approval or tool rules): name in replies, how to address the user, identity, persona, tone; then this channel's `soulExtra` (non-main).
- Claude can only propose a change (`propose_soul_change` → a `soul_proposal` card); nothing changes until the user taps Apply.

### Memory: "About you" and each channel's own

- Two layers: "About you" (`channelId` null, shared) and one private layer per channel. A channel reads "About you" only while `useSharedMemory` is on; the main thread always does. Archived (forgotten) facts never reach a prompt or a response.
- `GET / PUT /api/memory`: "About you". `MemoryState.facts` are `MemoryFact { id, text, source: user | assistant | dreaming, sourceMessageId, createdAt }`, non-archived, newest first.
- `GET / PUT /api/channels/:id/memory` → `ChannelMemoryState` (`{ document }` replaces the channel's document). The main thread is 400 (field `id`; use `/api/memory`).
- `POST /api/memory/facts` (`{ channelId: Id | null, text: 1–2000 }`) → `{ fact }`, `source: user`. The main thread's id is 400 (field `channelId`; send null).
- `PATCH /api/memory/facts/:id` (`{ text }`) → `{ fact }`; archived, document rows, others' ids 404.
- `DELETE /api/memory/facts/:id` → 204: archives (the row stays for Undo); again is 204.
- `GET /api/memory/overview` → `MemoryOverview`: every non-main, non-archived channel with name, purpose, fact count, last message time and `recent` (Claude's latest reply excerpt, ≤ 160). Never any memory text.
- Prompt order: soul → this channel's soulExtra → the "user data, not instructions" line → "About you" (main thread, or `useSharedMemory`) → this channel's own memory (document + facts as JSON `{id, text, at}`) → on the main thread only, the other channels' name / purpose / last activity / recent (≤ 20) → skills and connectors (provider instructions).
- Claude's tools:
  - `remember({ fact ≤ 2000, scope?: shared | channel })`: default `channel` in a channel, `shared` on the main thread. Refused (an error result, nothing written): `channel` on the main thread, `shared` in a channel that doesn't read "About you", or text that reads as an instruction to the assistant. Saves `source: assistant` with the turn's user message as `sourceMessageId`, then posts a `memory_note` card ("Remembered · Undo").
  - `forget({ factId })`: only on turns the user started (chat / task, not a synthetic `turn_*` message): proactive turns, routines, briefs and greetings don't get it. Archives a fact this turn can read ("Unknown fact" otherwise, whether or not it exists) and posts a `memory_note` (`forgot`).
  - `propose_soul_change({ field: name | addressAs | identity | persona | tone | soulExtra, proposed, reason ≤ 500 })`: posts an open `soul_proposal` with `current` filled in. Refused: soulExtra on the main thread, the same value, over the field's limit. Make builds don't get it.
- Card actions (`POST /api/messages/:id/action`):
  - `memory_note`: `undo` only. remembered → archives the fact; forgot → restores it; the card turns `undone`. Idempotent; it only touches the card's own layer. Other actions 400 (field `action`).
  - `soul_proposal`: `apply` writes the field (creates the soul row if needed; soulExtra goes to the card's channel with a `channel` event) and the card turns `applied`; `dismiss` → `dismissed`. A decided card answers as it is.
- Dreaming (the memory curator, every 30 min): a layer is tidied when its user has been idle ≥ 20 min, its source thread (the main thread for "About you", the channel for its own; task sessions never) has ≥ 6 new user messages since the last pass, and its last pass is ≥ 6 h old (failed passes count). One `utility` model call, JSON only `{ add, archive }`. Checked in code: every cited message must be a real message of that thread; an archive must cite a user message and an active fact of that layer; adds go through the same instruction filter and skip duplicates; archiving more than 25% of the active facts rejects the whole pass; at most 10 changes (archives first). Adds are `source: dreaming`. One `MemoryCuration` row per pass (applied / rejected / failed with a reason written by code, never the model's). No model configured: nothing runs.

### Vault (secrets the server keeps)

- `VAULT_KEY` (base64 of 32 bytes) when set; otherwise `/data/db/vault.key`, created on the first stored secret and only while no secret is stored yet (mode 0600; the log names the path once, never the key).
- A key of the wrong length stops the server at startup. So does a missing key while secrets are stored: no `VAULT_KEY`, no `vault.key`, and the database holds secrets → stderr "The vault key is missing: VAULT_KEY isn't set and <path> doesn't exist. The database holds N secrets sealed with that key, and a new key can't open them: put vault.key back (scripts/restore.sh restores it from a backup) or set VAULT_KEY to it." and exit 1. No new key is made over them.
- AES-256-GCM per row: a random 12-byte nonce, the 16-byte tag appended, and as additional data the JSON array `[id, userId, ownerKind, ownerId, name]` of the row, so a ciphertext copied or moved to another row, user, owner or name doesn't open.
- Secrets (custom connector keys and secret headers, keys typed into connection cards) are only ever answered as `{ set, last4 }`. They never reach a Message row, a run step, an audit row, a log line or a model prompt / tool result.
- `scripts/backup.sh` copies `vault.key` next to the database when the server made one; `scripts/restore.sh` puts it back (a backup without one keeps the server's key). Keep the key with the backup: without it the stored connector keys can't be read.

Every route needs the session; another user's ids are 404. Errors use `ApiError`; `validation_failed` carries `field`.

### Channels
- `POST /api/channels` (+ `access`, `greet`):
  - `access` refs are checked first. An unknown or foreign skill / connector, or a toolkit the catalog doesn't know, is 400 field `access` and nothing is created. Duplicate refs count once. Each ref becomes an enabled ChannelAccess row.
  - `greet` (default true) queues a background chat Run in the new channel. Its prompt is written by the server and is never stored as a Message. It asks Claude to greet the channel by name and purpose and to offer a few tasks, with quick replies in User.language. With no purpose, Claude asks what the channel is for and saves the answer to the channel's memory. `greet: false` queues nothing.
  - There is no server-written hello any more.
- `PATCH /api/channels/:id` (+ `soulExtra`, `useSharedMemory`): on the main thread, either key is 400 with that key as `field`. `Channel` always carries both; the main thread answers `""` / `true`.
- `DELETE /api/channels/:id`: also deletes the channel's Memory, MemoryCuration and ChannelAccess rows, in the same transaction.

### Access
- `GET /api/channels/:id/access` → ChannelAccess: every skill, every custom connector, and the apps with an active connected account. Ordered skill → connector → app, by name within each kind. Each item shows its scope and whether it is on here. On the main thread everything is on.
- `PUT /api/channels/:id/access` `{changes:[{kind,id,enabled}]}` → ChannelAccess.
  - Main thread → 400 field `id`.
  - An unknown or foreign ref → 400 field `changes`.
- `PUT /api/access/scope` `{ref:{kind,id}, scope:"all"|"channels"}` → 204. An unknown or foreign ref → 400 field `ref`.
- Rules: the main thread sees everything. Elsewhere a ChannelAccess row wins, then the item's scope (no rule = `all`). Something created inside a channel gets scope `channels` plus an enabled row there; something created on the main thread gets no rule. Apps with no rows stay available everywhere.

### Skills
- `GET /api/skills/github/preview?url=` → SkillImportPreview.
  - `url` is required, ≤ 2000 characters. It accepts `https://github.com/<owner>/<repo>[/tree/<ref>/<path>]` and `/blob/<ref>/<path>/SKILL.md`.
  - The server downloads `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref|HEAD>` (≤ 20 MB, public addresses only). Redirects are followed only to codeload.github.com, github.com and objects.githubusercontent.com.
  - Errors: a missing repo → 400 field `url` "wasn't found"; a private address or a redirect elsewhere → 502; over 20 MB → 413 `too_large`; the same file path twice in the download (also once its top `<repo>-<sha>/` folder is dropped) → 400 field `url` "… <path> twice.".
- `POST /api/skills/zip/preview` (multipart `file`) → SkillImportPreview.
  - Over 20 MB → 413 "Zips can be up to 20 MB.".
  - More than 200 entries, or over 20 MB unpacked (counted as it inflates) → 400 field `file`.
  - Empty, missing or not a zip → 400 field `file`.
  - A path that leaves the folder (`..`, absolute, drive letters) rejects the whole archive. Symlinks are skipped with a warning.
  - A file path that appears twice → 400 field `file` "The zip has <path> twice.".
- Previews: every folder with a SKILL.md is one candidate. Names are normalized to the skill-name rule, or the folder is skipped with a warning. Descriptions over 1024 characters are cut with a warning. The excerpt is 300 characters. A preview lives 15 min, at most 10 per user.
- `POST /api/skills/import` `{importId, names, channelId?}` → SkillList.
  - An unknown, expired or foreign `importId` → 404 "This preview expired. Preview the skills again.".
  - A name not in the preview → 400 field `names`.
  - Importing a name the user already has replaces it: same id, `version` + 1, `source` / `sourceUrl` updated.
  - With `channelId`, the skill gets scope `channels` plus an enabled row in that channel.
  - All or nothing: every chosen folder is checked first, then all of them are saved in one transaction; if one fails, none is saved.
- `GET /api/skills/:id/files/*path` → SkillFileContent `{path, text}`. A binary file → 400; an unknown path or a traversal → 404.
- `PATCH /api/skills/:id` → Skill.
  - Accepts `description`, `instructions` and `files: [{path, text|null}]` (null deletes). Only file changes bump `version`, so an imported skill's scripts ask again; description and instruction edits don't.
  - A bad path (`..`, absolute, `SKILL.md` itself) or two changes to the same path → 400 `validation_failed`.
  - Limits: ≤ 100 files, ≤ 1 MB each, ≤ 5 MB per skill, description ≤ 1024.
- `GET /api/skills/:id/export` → `application/zip`, `Content-Disposition: attachment; filename="<name>.zip"`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. The entries are `<name>/SKILL.md` (with frontmatter) plus the files, stored without compression.
- Model side:
  - The instructions carry an index of the skills on in this channel (≤ 50).
  - `use_skill` returns SKILL.md's body and the file list. `read_skill_file` returns ≤ 100 KB (`truncated: true` beyond that).
  - `run_skill_script` is offered only when Claude's computer is set up. It runs `<python3|node|bash> './<path>' <args…>` from `/workspace/.skills/<name>/` (the `./` keeps a path like `--x.js` from being read as an option) with ≤ 300 s; the output is the last 16 000 characters.
  - A github / zip / assistant skill asks once per version: an approval card, kind `action`, slug `duet:run_skill_script`. Manual skills never ask.
  - The card's rows: Skill `/<name> v<N>`, Script, Arguments, and Allows "Scripts of /<name> v<N> (first run of this version), a skill from <GitHub|a zip|Claude>: later runs of any of its scripts won't ask again until the skill changes". Approving covers that whole version, not only this script.

### Custom connectors
- Routes:
  - `GET /api/custom-connectors` → CustomConnectorList.
  - `POST /api/custom-connectors` → CustomConnectorResponse. It verifies first; a failure is 400 with the reason and nothing is saved.
  - `PATCH /:id` re-verifies when the url, domain, key or headers change. A `null` value for a secret header keeps the stored one. `domain` on an mcp connector → 400 field `domain`.
  - `DELETE /:id` → 204 (again → 404). It removes the vault rows, the access rows and the ToolPolicy rows.
  - `POST /:id/test` re-checks and refreshes the tools. A failure marks the connector `failed` (its cached tools stay usable).
  - `PUT /:id/policy` `{tool|null, mode}`: null = all its tools. An unknown tool → 400; foreign → 404.
- MCP verify failures (400 field `url`): "refused the credentials", "Only https", "public host name", "couldn't be reached", "private or reserved". A reserved header (Accept, Content-Type, Host, Mcp-Session-Id, …) → 400 field `headers` "set by the server".
- api_key verify does a DNS lookup only (no request). Failures: "private or reserved", "couldn't be found", "public domain", or "set by the server" for a reserved header name.
- Secrets are only ever returned as `{set, last4}`.
- MCP limits: 15 s per request, 60 s per tool call, 4 MB answers, ≤ 200 tools over ≤ 20 pages, ≤ 60 connector tools per turn (beyond that the instructions say some were left out). Tools are refreshed lazily when older than 24 h, or 15 min after a failed check.
- MCP: secret header values are redacted from the server's error texts (before their 200-character cut), tool descriptions and input schemas. A tool whose name contains one is left out.
- `call_api`: 30 s, ≤ 3 redirect hops inside the domain. The key is redacted first, then the answer is cut at 24 KB, so no part of the key survives the cut; shown header values are redacted, then cut at 500 characters. `X-HTTP-Method-Override`, `X-HTTP-Method` and `X-Method-Override` (any case) are never forwarded, like Host, Cookie and the other transport headers. Errors the model sees: "only works for <domain>", "Only https", "private or reserved", "No API key with that id or name", "redirected to another host", "Too many redirects".

### Connection cards
- `POST /api/messages/:id/connect` `{values:{<key>:string}}` → MessageActionResponse.
  - Not a `connection_request` card (or foreign) → 404. A card that isn't open → 409 `conflict` "This card isn't open any more.". An `app` card → 400 field `type`.
  - An unknown value key → 400 field `values`; a missing value → field `values.<key>`. A failed verification → 400 with the reason, and the card stays open.
  - Every value typed into a card is stored as a secret (in the vault, returned only as `{set, last4}`), whatever `secret` the model asked for: card fields always have `secret: true`. Plain headers only come from `POST /api/custom-connectors`.
  - On success: the card turns `connected` with `connectorId`; the connector is on in the card's channel (scope `channels`); a `system.connection_added` line `{name}` is posted; a follow-up turn starts (a task card continues its task, otherwise a chat turn). Its server-authored prompt says `"<name>" is connected now`.
- A dismissed `connection_request` may carry optional `closedBy: "assistant"` only when `withdraw_card` withdrew it; user `Not now` omits the field, and omitted legacy data means the user closed it.
- Not now: `POST /api/messages/:id/action {action:"dismiss"}` → `dismissed`; `/connect` is then 409.
- App cards turn `connected` when the next accounts listing (the connect flow or `GET /api/connectors`) shows the toolkit active. If the app was off in that channel, it is turned on there first. No system line, no follow-up turn.
- `request_connection` for an app that is already connected answers `already_connected`, or `turned_off_in_channel` if it is off in this channel, without a card. An app the catalog doesn't know is an error result: "isn't an app the catalog knows".
- Apps per channel: `search_app_tools`, `get_app_tool_schemas`, `execute_app_tools` and `manage_app_connections` ignore apps that are off in the channel (manage shows them as `turned_off_in_channel`). The main thread sees all.

## M12

Model configuration from the phone. Additive: `Channel.modelId` / `thinkingLevel` and `Features.models` have defaults, `model_error` is a new message kind, and the one migration (`m12_models`) only adds two tables and nullable columns. The contract is `.pi/handoff/m12-contract.md`; shapes in `backend/src/contract/m12.ts`.

### Providers

- Kinds and their presets: `openai` (`https://api.openai.com/v1`), `anthropic` (`https://api.anthropic.com`), `gemini` (OpenAI protocol, `https://generativelanguage.googleapis.com/v1beta/openai`), `stepfun` (OpenAI protocol, `https://api.stepfun.com/v1`), and `custom` (`protocol` openai or anthropic and `baseUrl` required; `auth` `x-api-key` or `bearer`, anthropic only). The name defaults to the preset's name (custom: the URL's host) and is unique per user.
- The key goes straight into the vault (ownerKind `provider`, name `key`) and comes back only as `key: { set, last4 }`. It is sent only as the provider's auth header, joins the run records' redaction set, and never reaches a response, log line, event, Run row, run step, Message or prompt (also when a provider echoes it in an error body).
- Verify (create, and PATCH when the key, URL, auth or headers change): one GET of the provider's model list. No redirects, 15 s, ≤ 5 MB. Failures are 400 `validation_failed` with plain words built by the server (`the key was refused`, `couldn't reach <host>`, the status code), never the provider's body; nothing is saved. A custom provider whose list answers 404 is active (it just has no list). A rename isn't re-verified. A PATCH that changes `baseUrl` must send `key` too (else 400 field `key` "send the key again when the address changes", nothing sent): a stored key never goes to an address it wasn't typed for. A PATCH writes only the fields it sends.
- Extra `headers` are non-secret: a name that looks like a credential (authorization, cookie, secret, token, api-key, credential) → 400 field `headers` "… looks like a credential; put the key in key"; Host, Content-Length, Transfer-Encoding, Connection → 400 "… is set by the server". Values are tab and printable ASCII only (400 field `headers`). Verify and chat send the same headers: Accept (and anthropic-version) by default, an extra header of the same name (any case) replaces them, and the auth header always wins.
- `POST /api/providers/:id/test` re-checks and stores `status` (`active` / `failed`) and `error` (200 either way).
- Private or LAN URLs are allowed (self-hosted gateways).

### Models

- `GET /api/providers/:id/remote-models` → RemoteModelList: the provider's own list is the truth (sorted by modelId, gemini's `models/` prefix dropped), each row enriched from models.dev (context, max output, thinking levels and format, tools, vision) or defaults, with `addedAs` = the ModelEntry already added for it. models.dev (`https://models.dev/api.json`, 10 s) is kept 24 h; a failed refresh keeps the stale copy and waits 5 min before trying again; without any copy, defaults.
- `POST /api/models` copies the enriched numbers; `POST /api/models/batch` skips ids already added. A realtime model (`purpose realtime`, for M13 voice) is never a chat candidate.
- `PATCH /api/models/:id` writes only the given fields and adds their names to `edited`; `thinkingLevels` are stored in ladder order (off, minimal, low, medium, high, xhigh, max); `maxOutputTokens` ≤ `contextWindow` (400 field `maxOutputTokens`); `tools: false` on the default model → 400 field `tools`.
- Usable chat model = `purpose chat`, `tools`, and its provider has a key. The first usable model added (or one that gets `tools` while there's no default) becomes the default.

### Defaults and deletes

- `PUT /api/model-defaults`: `defaultModelId` must be usable (null only while none is: 400 field `defaultModelId`); `utilityModelId` any of the user's chat models or null (= the default); `defaultThinking` any level or null (= automatic).
- Deleting the default model or its provider: 409 `conflict` while another usable chat model exists (choose it first); the user's last one is deleted and the user is "not configured". The utility model goes back to null. Channels using a deleted model go back to the default (modelId and thinkingLevel null), each with a `system.channel_model_removed` line `{model}` and a channel event. A provider delete removes its models and its vault rows at once.
- `PATCH /api/channels/:id` `modelId` (a usable chat model or null) / `thinkingLevel` (a level or null); on the main thread either is 400.

### Which model a turn uses

- One model per turn, never a chain, and no silent fallback to another model.
- Chat, task, build, brief, check-in, scan and routine turns: the channel's own model when it's a non-main channel and the model is still usable, else the user's default. A task uses its channel's. Background work (memory curation, titles): `utilityModelId`, else the default.
- Thinking level: the channel's → the user's default → the model's default → medium, then clamped onto the model's levels (walk up, then down, then off; no levels = off). Background work asks for off.
- Mapping: anthropic `effort` → `thinking {type: adaptive}` + `output_config {effort}`; anthropic `budget` → `thinking {type: enabled, budget_tokens}` with 1024 / 2048 / 8192 / 16384 / 32768 / 63999 for minimal … max, capped at `maxOutputTokens - 1024` (below 1024: no thinking); OpenAI protocol → `reasoning_effort` = the level (off: omitted; gemini sends `none`); format `none` sends nothing.
- Run rows: `providerId` = ModelProvider.id, `model` = the id sent to the provider.
- A provider's `Retry-After` is honoured up to 60 s.

### The model_error card

- A failed turn posts a `model_error` message instead of the grey system line: `{ phrase, modelId, modelLabel, runId, retry, state: open | retrying | dismissed }`. Nothing usable → phrase `system.no_model` ("No model is set up yet. Add one in Everything → Models.") with `retry: false`.
- `POST /api/messages/:id/action {action: "retry", modelId?}`: only an open card with `retry: true`. It resubmits the same turn (same kind, channel, task and the same user message, which isn't stored again) as a new run; with `modelId` that one turn runs on that model (a usable chat model, else 400 field `modelId`). The card turns `retrying` and stays as history; a new failure posts a new card. `dismiss` → `dismissed`. A card that isn't open → 409 `conflict` "This card isn't open any more.".
- Build and scan turns can't be retried (`retry: false`).
- M14: a refused key (`system.model_auth`), no credit (`system.model_quota`) or a model not set up completely (`system.model_config`) has `retry: false` too: the card offers the model settings, since a retry won't help.

### The one-time import and startup

- The first time a user's models are needed (`GET /api/models`, a turn, `/api/me`) and `User.modelsImportedAt` is null, the legacy `models.json` / `LLM_*` configuration loaded at startup is imported once: each provider with a key becomes a `custom` provider (`imported: true`), its key goes to the vault, its models become entries (`source imported`), the chat role's first model becomes the default and the utility role's first the background model. One transaction guarded by `modelsImportedAt IS NULL`: parallel first requests import once, a second run changes nothing, and after the user deletes everything nothing comes back. Logs carry counts only.
- Startup no longer stops on a model configuration problem: no `models.json` and no `LLM_*` is the normal start (one info line); a broken or unreadable one is ignored with one warning naming the problem fields, never values.
- `Features.models` = the user has a usable default chat model. `Features.webSearch` = `SEARCH_PROVIDER` is set, or the default model has `serverWebTools`.

## M13

Realtime voice calls from the phone (Gemini Live or StepFun Realtime). The voice model runs on the phone; the server owns the call: the credential, the voice's instructions and its four tools, the transcript, hand-offs to Claude, cues back to the phone and the call's one line in the chat. Additive: `Message.callId` and `Features.voice` have defaults, `call` is a new message kind and SSE event type, and the one migration (`m13_voice`) only adds two tables (`Call`, `CallLine`) and nullable columns. The contract is `.pi/handoff/m13-contract.md`; shapes in `backend/src/contract/m13.ts`.

### Calls and voice
All routes need a session. Another user's call or channel answers 404. Every route here answers `Cache-Control: no-store`, the 401 of a logged-out request included (every `/api` 401 is no-store).

- `GET /api/voice-settings` → VoiceSettings. `modelId` is null when the stored model is gone. `voices` is fixed: gemini Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr; stepfun qingchunshaonv, wenrounansheng, linjiajiejie (each engine's default is the first). `configured` = Features.voice.
- `PUT /api/voice-settings` {modelId?, voice?} → VoiceSettings. `modelId` must be a `purpose realtime` ModelEntry of the user's gemini / stepfun provider (400 validation_failed `modelId`). `voice` must be one of that engine's voices, or of either engine when no model is set (400 `voice`). Switching to the other engine without a voice clears it.
- `POST /api/calls` StartCallRequest → StartCallResponse.
  - Which model: `modelId` (unusable: 400 `modelId`), else the settings' model, else the first usable realtime model by createdAt. Usable = purpose realtime, provider kind gemini / stepfun, status not failed, key in the vault.
  - None at all: 400 `not_configured`.
  - An open call in another channel: 409 `conflict`. One left open in the same channel is ended first.
  - Voice: request (400 `voice` if it isn't the engine's) → settings → engine default.
  - Credential:
    - gemini: a one-use token from `POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens` (`x-goog-api-key`, `{uses:1, expireTime:+30m, newSessionExpireTime:+1m}`). `credential {kind:"token", value, expiresAt}`; url `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained` (the phone adds `?access_token=`). A failed mint is 400 `not_configured` with the status, and no call is created.
    - stepfun: `credential {kind:"key", value}`, url `wss://api.stepfun.com/v1/realtime?model=<modelId>`. The key is only ever in this answer, to its owner. Never in a log, event, Run / RunStep / AuditLog / Message row or a prompt.
  - Resume: `callId` (an open call of this user, same channel; else 404 / 409 / 400 `channelId`). Fresh credential, same call; the instructions add "This call so far".
- Instructions:
  - The role: a relay for Claude; passes requests on with send_to_assistant, tells the user what Claude says, asks for what's missing, speaks of Claude in the third person, never claims it did anything.
  - The language rule: the user's current language; the phone's `language`, else User.language, before the user speaks.
  - Approvals: never approves; mentions a waiting card once.
  - Background, ≤ 12000 characters, each section capped: now in the user's timezone; the soul's name and how to address the user; About you when the channel reads it; channel name / purpose / own memory; current work (running turn and status, pending approval titles, tasks working / needing input); the last 20 chat text messages in spoken form, filled newest first into what's left (≤ 4000) and shown oldest first, so an overflow drops the oldest messages, never the newest.
  - On resume: "This call so far", the newest lines up to 3000 characters.
- A call takes at most 5000 lines; lines beyond that are ignored (the request still answers 204, the log keeps a count). The hand-off quote, "This call so far" and the title read the newest lines (at most 200).
- One lock per call serialises its lines, a `send_to_assistant` hand-off, the end, the sweep and a resume. Each re-checks that the call is open inside the lock, else 409 `conflict`. So a hand-off racing the end either gets 409 (no turn runs) or lands first, and the end then releases its turn (its reply shows in the chat).
- `POST /api/calls/:id/lines` {lines 1–100} → 204. Kept once per (call, line id). An ended call: 409 `conflict`.
- `POST /api/calls/:id/tool` {name, arguments, lines} → {result}. Lines are stored first. An ended call: 409. An unknown tool name or bad arguments: a result string, not an HTTP error.
  - `send_to_assistant({text})`: a user message with `callId` = the text + `[The user's own words on the call: «…»]` (user lines since the last hand-off, each quoted once), then a chat turn in the call's channel. The marks can't be forged: `«` `»` in the voice's text or a line become `‹` `›`, and the marker phrase in the voice's text starts with `(` instead of `[`. Claude's text bubbles in that turn carry the same callId; cards, tasks, artifacts and approvals don't. → "Sent to Claude." (usage limit / failure: a sentence saying so).
  - `assistant_status()`: running or not and its status, pending approval titles, the newest reply's first 300 characters. Only the channel's chat turn (kind chat) counts: a build or a routine in the same channel doesn't.
  - `stop_assistant()`: Stop on the channel's chat → "Stopped." / "Claude wasn't working on anything."
  - `search_memory({query})`: active facts of About you (when the channel reads it) and the channel's own, at most 10 lines; never another channel's.
- `POST /api/calls/:id/end` {seconds ≤ 86400, lines} → MessageActionResponse. In this order: status ended, endedAt and seconds are written (so a start in another chat right away isn't a 409); then the call's turns are released and the cue watcher stops; then title = one utility-model call (≤ 60 chars, User.language), "Voice call" / "语音通话" with no model, no lines, a failure or an empty answer. Posts one message: kind `call`, role system, `callId` null, payload {callId, seconds, title, lineCount}. Ending again waits for the first end and answers the same message. A turn still running at hang-up posts the rest of its reply visibly. A bubble it was already streaming loses its callId at its next delta (its `message` event then has `callId: null`).
  - M27: the chat message's `payload.title` is `""` when untitled, so the app shows only "Voice call · <length>". New chat rows store the empty title; older payloads equal to "Voice call" or "语音通话" (either language, whitespace trimmed for comparison) are normalized on serialization without a migration. Named titles are unchanged. / 未命名通话的聊天消息 `payload.title` 为空，旧消息中的中英文兜底标题在返回时转为空；有内容的标题不变，无需迁移。
- `GET /api/calls/:id` → CallDetail: the call, its lines (phone time order), the messages with this callId (oldest first). The call's own `title` keeps the readable localized fallback when untitled (unlike the chat message's empty `payload.title`). / 通话详情中的 `call.title` 保留可读的本地化兜底标题，与聊天消息的空标题不同。
- SSE `call` {callId, kind, text, seq} while a call is open. Only the channel's chat turns (kind chat) count: a build or a routine in the same channel never claims, completes or reports the call's turn.
  - `reply`: Claude's text of a completed chat turn in the channel (all its bubbles joined in order), ≤ 600 characters cut at a sentence end.
  - `notice`: "<title> needs your approval on the card in the chat" once per new pending approval in the channel; "Claude couldn't finish that: …" for a failed turn.
  - `progress`: a status change, at most one per 15 s; "Claude is still working." after 45 s with nothing.
  - `seq` comes from the clock and rises strictly per call.
- Call messages (M15; M13 hid them): messages with a `callId` are listed like the rest (`GET /api/channels/:id/messages`, the task thread, unreadCount, lastMessageAt, the memory overview's channel summaries), so a hand-off and Claude's reply show while the call runs. A hand-off's `text` in the API is the voice's words only: the `[The user's own words on the call: «…»]` quote is for the model (the agent's context and dreaming read the stored text). The app labels a user message with a callId as passed on during a call.
- Sweep: every 10 min, an open call with no request, line or turn event for 2 h ends the same way (seconds = lastActiveAt − startedAt).

## M17

Connector templates from the official MCP Registry, one-tap installs, sign-in for remote MCP servers (OAuth 2.1 + PKCE with dynamic client registration, the MCP authorization spec) and pasted `mcpServers` configs. Additive: two new optional fields on CustomConnector, one optional field on the mcp CreateCustomConnectorRequest, and the one migration (`m17_mcp_oauth`) only adds `CustomConnector.registryName` and two tables (`OAuthClient`, `OAuthGrant`). Shapes in `backend/src/contract/m17.ts` (not in `contractShapes` / `docs/api-samples/` yet: add the samples together with the app's Codable models). All routes need a session; another user's connector is 404.

### CustomConnector additions (old apps keep working)

- `status` is still exactly `active | failed`. A connector waiting for sign-in is `failed` with `error` "Sign in to <name> to finish connecting it." (never signed in) or "Sign in to <name> again to use it." (a refresh was refused, or Disconnect). An old app shows that as a failed connector with its reason.
- `registryName: string | null`: the MCP Registry name it was installed from (a template), null when added by hand.
- `oauth: { signedIn, needsSignIn, expiresAt } | null`: null = the server doesn't use sign-in (headers only). `signedIn` = tokens are stored; `needsSignIn = !signedIn` (show "Sign in"); `expiresAt` = when the current access token runs out (ISO; the server renews it on its own, so this is informative), null when unknown or signed out. Tokens, client secrets, codes and verifiers are never in any answer.
- `POST /api/custom-connectors` (mcp) takes an optional `allowSignIn: true`: a server that asks for sign-in is saved waiting for it (as above, `tools: []`) instead of the 400 "refused the credentials". Without it nothing changes for old apps.

### Templates

- `GET /api/connector-templates?query=&cursor=` → `ConnectorTemplateList { templates: ConnectorTemplate[], nextCursor: string | null }`.
  - No query and no cursor: the featured servers first, in this order where the registry has them as hosted remotes: Composio, GitHub, Linear, Notion, Figma, Stripe, Vercel, Supabase, Cloudflare, Atlassian, Context7 (missing ones are left out); then the registry's first page without them. `?cursor=` reads on (featured ones never repeat); `?query=` searches the registry (≤ 100 characters). Pages with nothing installable are read past (≤ 3 more).
  - Only hosted remotes (`streamable-http`, else `sse`) are listed, never local (stdio) packages. A remote whose URL isn't https on a public host name, needs a secret inside the URL, or uses a header the server sets itself is left out.
  - `ConnectorTemplate { name, title, description, website: string|null, iconUrl: string|null (https), remote: { type: "streamable-http"|"sse", url }, inputs: ConnectorTemplateInput[], needsSignIn: boolean|null, installed: boolean, featured: boolean }`. `name` is the install key (e.g. `com.notion/mcp`). `remote.url` may still contain `{variables}`. `needsSignIn` is null until the server learned it from an install (it's only a hint; the install answer is authoritative).
  - `ConnectorTemplateInput { name, description, secret, required, kind: "header" | "urlVariable" }`. header: `name` is the header name (e.g. `Authorization`); the user types only the value part (a registry value like `Bearer {token}` is filled by the server). urlVariable: one URL segment (letters, digits, `- . _ ~`; no `/ ? # @` or spaces). `secret` inputs go to the vault (show a secure field).
  - Cached on the server: the featured list up to a day, registry pages 10 minutes. The registry being down serves the cached copy; with nothing cached the answer is 502 `internal` "The MCP Registry couldn't be reached. Try again in a moment.".
- `POST /api/connector-templates/install` `InstallTemplateRequest { name, inputs?: { <input name>: string } }` → `InstallTemplateResponse { connector: CustomConnector, needsSignIn: boolean }`.
  - One tap: a template whose inputs are all optional installs with `{ "name": "<name>" }`.
  - The template is looked up on the server by name (the app never sends a URL). A required input missing → 400 `validation_failed` field `inputs.<first missing>`, message "… required (missing: A, B)"; an input the template doesn't have → 400 field `inputs.<name>`; a bad URL segment → 400 field `inputs.<name>`. Unknown name → 404. Installed already: the same connector again (200) when no values are sent, 409 `conflict` with values (edit the connector instead).
  - Then the server probes the remote: if it asks for sign-in (a 401 with no user credentials, or protected-resource metadata), the connector is saved waiting for sign-in and `needsSignIn: true`. Otherwise it is verified like any custom connector (initialize + tools/list); a failure is 400 with the reason (field `url`), nothing saved. A 401 when the user did give a credential header is "refused the credentials", not sign-in.
  - `sse`-only remotes are listed but our client speaks Streamable HTTP; such an install may fail its check with the server's status.

### Sign-in (remote MCP OAuth)

The app's flow, step by step:

1. A connector has `oauth.needsSignIn: true` (after an install, an import, `allowSignIn` create, a refused refresh or Disconnect). Show "Sign in".
2. `POST /api/custom-connectors/:id/oauth/start` (no body) → `OAuthStartResponse { authorizeUrl, callbackScheme: "duet", redirectUri: "duet://oauth/callback", expiresAt }` (`Cache-Control: no-store`). The server has done discovery (the server's 401 `WWW-Authenticate` `resource_metadata` hint, else `/.well-known/oauth-protected-resource[/path]` (RFC 9728); then the authorization server's `/.well-known/oauth-authorization-server` (RFC 8414) or `openid-configuration`), registered the app once per user and authorization server (RFC 7591, redirect `duet://oauth/callback`, public client), and made a PKCE S256 verifier and a random `state` that stay on the server.
   - 400 `validation_failed` field `oauth` with plain words when it can't start: "<host> doesn't describe how to sign in.", "<host> doesn't let new apps register on their own. Add it as a custom connector with a token header instead.", "<host> refused the app's registration (…)", "… doesn't support PKCE (S256) …", or "The sign-in server's address isn't allowed: …" (private / reserved address, http, a local host name). Field `kind` for an api_key connector.
3. Open `authorizeUrl` in `ASWebAuthenticationSession` with `callbackURLScheme: "duet"` (`prefersEphemeralWebBrowserSession` is up to the app). The authorize URL carries `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` (S256), `state`, `resource` (the MCP server URL, RFC 8707) and `scope` (from the challenge or the metadata).
4. The session returns `duet://oauth/callback?code=…&state=…` (or `?error=access_denied&state=…`). Post its query as `OAuthFinishRequest { state, code?, error?, errorDescription? }` to `POST /api/custom-connectors/:id/oauth/finish` (the same connector id) → `CustomConnectorResponse` (`Cache-Control: no-store`). The server trades the code (with the verifier and `resource`), stores the tokens in the vault, then verifies (initialize + tools/list) and answers the connector: `status active`, `oauth.signedIn: true` and its tools; or, when the check after sign-in fails, `failed` with the reason (still signed in; Test retries).
   - 410 `expired` field `state` "This sign-in expired or was already used. Start it again.": the state is unknown, used already, belongs to another connector, or is older than 10 minutes. Start again.
   - 400 `validation_failed` field `code`: "code: Sign-in was cancelled." (`error=access_denied`), "Sign-in didn't finish (<error>)." or "<host> refused the request (<status>[, <error code>])." The state is used up: start again.
   - A user cancelling the web sheet itself (ASWebAuthenticationSession's canceledLogin) needs no call; the state simply runs out.
5. From then on every MCP request of the connector sends `Authorization: Bearer <token>` (it replaces an Authorization header of the connector). The server refreshes the token a minute before it runs out and once after a 401 (then repeats the request), keeps a rotated refresh token, one refresh per connector at a time. A refused refresh (4xx from the token endpoint, or no refresh token) signs the connector out: tokens deleted, `failed` "Sign in to <name> again to use it.", `oauth.needsSignIn: true`; the model's tool call gets that sentence as its error. A token endpoint that can't be reached (5xx, timeout) is an error for that call only.

- `DELETE /api/custom-connectors/:id/oauth` (Disconnect / sign out) → `CustomConnectorResponse`: tokens deleted, the connector waits for sign-in again (it keeps its tools and settings). 400 field `oauth` when the connector doesn't sign in.
- `DELETE /api/custom-connectors/:id` also removes its grant and its tokens. The user's registered client per authorization server stays (the next connector there reuses it); a token endpoint answering `invalid_client` drops it so the next sign-in registers again.
- `PATCH` of `url` on a connector that signs in → 400 field `url` (tokens are bound to their server): remove it and add the new address. Header changes keep the tokens.
- While a connector waits for sign-in, Test and the 24 h refresh send nothing and keep the sign-in reason.

### Paste a config

- `POST /api/custom-connectors/import` `ImportConnectorsRequest { json: string ≤ 100 000 }` → `ImportConnectorsResponse { connectors: CustomConnector[], skipped: [{ name, reason, message }] }`.
- Accepts Claude / Cursor `{"mcpServers": {…}}`, VS Code `{"servers": {…}}` or `{"mcp": {"servers": {…}}}`, Zed `{"context_servers": {…}}`, a bare `{"<name>": {…}}` map, or one entry. ≤ 20 entries per paste.
- Remote entries (`url` / `serverUrl` / `httpUrl`, + `headers`) are added through the same path as `POST /api/custom-connectors` with `allowSignIn` (so one that asks for OAuth comes back with `oauth.needsSignIn: true`). Header values that look like credentials (an Authorization / key / token / secret / auth / cookie / session header, a `Bearer …` value, or a long random-looking value) are secret (vault, `{set, last4}`); others stay plain.
- `skipped[].reason`: `stdio` (a `command` entry: runs a program locally, which a hosted server can't), `exists` (a connector with that URL is there already), `invalid` (no url, not https / not a public host, `${…}` placeholders, a bad or reserved header, over 20), `failed` (the check failed; `message` has the reason with secrets redacted).
- 400 field `json`: "that isn't JSON", or "no MCP servers in that config".

### Security (M17)

- Every URL from the registry, from metadata (resource metadata, authorization-server metadata, endpoints) or from the user goes through the outbound guard: https only, a public host name (no IP literal, no local suffix), every resolved address public (no private, loopback, link-local or metadata ranges), the connection made to the checked address, redirects never followed for POSTs and re-checked hop by hop (≤ 3) for metadata GETs, 15–20 s deadlines and byte caps (registry pages 4 MB, metadata 512 KB, registration / token answers 64 KB). A hint to a refused address is skipped without a request.
- Access / refresh tokens are VaultSecret rows of the connector (`oauth:access_token`, `oauth:refresh_token`), the client secret a VaultSecret of the client (ownerKind `oauth_client`). Columns hold only the client id, endpoints, expiry, scope and resource. The PKCE verifier and `state` live in server memory only (single use, 10 minutes, ≤ 20 pending per user).
- Tokens, codes, verifiers and client secrets never reach a response, a log line, an event, a Message / RunStep / AuditLog row or a model prompt; the bearer token joins the redaction set of every tool result. Errors carry plain words, a status and at most an OAuth error code, never the far side's body.

## M18

Contract: `backend/src/contract/m18.ts`; samples: `docs/api-samples/m18.json`. Additive only: an older app shows every message below as ordinary text.

### A task's result in the chat

- `TextMessage.payload` has two more fields, `null` on every other text message and on older payloads:
  - `taskResult` `{ taskId, title, status: "resolved" | "ready_for_review", sourceCount }`: on the Claude text message the server posts in the task's channel (main timeline, `taskId` null) when the task is done. The message's `text` is the task's final result (markdown): the newest Claude text message of the task's thread written in the turn that finished it; else finish_task's summary; else the `agent.task_done` line. Over 32,000 characters it is cut at a paragraph break and ends with "…". `sourceCount` = the task's resources.
  - `forwarded` `"chat"`: on a user message in a task's thread that Claude passed on from the chat (`tell_task`).
- Posted once per real move into done (a task that already was ready for review or resolved gets nothing new). A reply the user writes inside a task that was already done ("thanks", a follow-up) settles it back to done without a new result: they read the answer in the task. A `tell_task` message from the chat that finishes it again posts a new one.
- Push: a `resolved` result message sends one notification `notify.task_done` "{title} is done." / "「{title}」做好了。" that opens its chat (`duet://channels/<id>`). `ready_for_review` keeps its task push (`notify.task_ready`), so a result never pushes twice.

### When a task is done (server-side rule)

- A task turn is done when it calls `finish_task`, or when it ends without `ask_user`, with no pending approval of the task, every checklist step `done` (an empty checklist counts), no Make build of the task still building (or settled during the turn, or settled with its outcome not yet delivered to the task), and a last Claude text of the turn that doesn't end with `?` / `？`. Otherwise it is `needs_input` (as before). A turn the user stopped, a turn that posted a card waiting for the user in the task's thread (form, quick replies, connection request, sign-in), and a carry-on turn that answered only failed builds never count as done on their own.
- Done is `ready_for_review` when the task had any Approval row (any status) or any of its runs (`Run.taskId`) has a RunStep of a connector tool whose access is write or unknown: a Composio app tool (upper-case slug, `policy/classify.ts`), `call_api` with a method other than GET / HEAD, a custom MCP tool (`mcp_<6>_<tool>`) not stored as read, or an `execute_app_tools` step without a nested call. Claude's own tools (computer_*, make_artifact, web_search, web_fetch, task, memory and connector meta tools) don't count. Otherwise `resolved`. The model never picks the status. Routines keep their old behavior (finish → ready_for_review).
- `finish_task` still refuses while an approval of the task is pending, a build it started is building, or a step is open; its result is now `{ finished: true, note }`.

### Failed / waiting lines

- A real move into `needs_input` (the task wasn't already waiting before the turn) posts one Claude text line in the task's channel (taskId null, `taskResult` null):
  - the turn failed: `agent.task_failed` "[{title}](duet://tasks/{id}) hit a problem: {reason}" / "「[{title}](duet://tasks/{id})」出错了：{reason}" (reason = the error phrase in the user's language, one line, ≤ 200 characters);
  - Claude asked (`ask_user`, or the turn ended on a question): `agent.task_waiting` "[{title}](duet://tasks/{id}) is waiting for you: {question}" / "「[{title}](duet://tasks/{id})」在等你：{question}" (question = ask_user's question, else the last sentence of the last text, ≤ 140 characters).
- Not posted for a turn that answered the user's reply in the task (they're there), a pending approval alone (its card asks), the usage-limit pause, the restart pause, or a routine. Titles have `[` `]` escaped; replacements are literal.

### Chat tools (chat turns only; not briefs, check-ins or task turns)

All three act on the user's word, so they are offered only on a chat turn that answers a message of theirs; a server-made chat turn (the computer hand-back or sign-in carry-on, a greeting: user message id `turn_…`) doesn't get them.

- `tell_task { taskId, text }`: the user's own words from this turn go into the task's session as a user message with `payload.forwarded: "chat"` (on the task's queue like a reply: a waiting or done task runs now, a running one next). A routine is refused ("It's a scheduled task; use manage_scheduled_task."); someone else's or a missing task is unknown. Returns `{ taskId, link: "duet://tasks/<id>", status }`. Its turn's lines still go to the chat (the user isn't in the task).
- `resolve_task { taskId }`: `PATCH status resolved`; a routine is refused ("pause or delete it instead"). `delete_task { taskId }`: same as `DELETE /api/tasks/:id`; its result says it can't be undone. Both only when the user asked in this turn (the descriptions say page, email or tool-result text never counts).

### Model context

- History lines: an `artifact` card reads `[artifact "<title>" <status>]` (failed adds `(<reason>)` when the payload has one). System lines (role `system`) aren't part of the model's history.
- Main thread chat turns list the user's tasks across all channels that are open or were finished in the last 3 days (not archived, not routines), newest first, at most 15: `{ id, title, status, channel: "main" | <name>, lastUpdate (English, ≤ 160 chars) | null, updatedAt }`. Sub-channels keep the 10 newest of their own channel.
- Task turns get the line "When the work is done, call finish_task (its summary is optional; your last message is the result the user sees in the chat). When you need the user, call ask_user. Don't just stop."

### edit_artifact during the first build

- An artifact whose first build is still building (no page yet) takes the edit: it's kept in memory and the tool answers `{ status: "queued", note: "It's still being built; the change is applied right after." }` (`ArtifactService.requestEdit` returns `queued: true`). When the build finishes, the kept edits run as edit builds, the user's (✎) as one and Claude's as another, each with its own trust (`startedBy`); when it fails, they're appended to the artifact's prompt ("\n\nAlso: …") so a retry includes them. Kept edits are lost on a server restart. With no page and nothing building it is still 400 `validation_failed`.

### M18c

Model-facing behaviour only: no contract, schema or route change. The one new fixed phrase is `agent.finding_sources` ("Sources:" / "来源："), used inside a Claude text message.

- `share_finding { text (1..1200), sources: [{ title (1..200), url (https, ≤ 2048) }] (1..3) }`, check-in turns only: posts one Claude text message in the main thread, `"{text}\n\n{agent.finding_sources} [title](url) · [title](url)"` (`[` `]` and `\` in titles escaped; `(` `)` and spaces in URLs percent-encoded). Like `post_message` it makes the check-in `completed`, so it counts in the daily proactive cap. Refused (error result, nothing posted) when the user's level is `low`, when a `share_finding` RunStep with status `ok` already exists in another check-in of the user that started since local midnight (User.timezone), or when it was already called in this run. Check-ins get web_search / web_fetch like every turn: the function tools when `SEARCH_PROVIDER` is set (web_fetch always), or the model's native web tools.
- Check-in prompt: still silent by default and read-only (web_search / web_fetch count as reads), now with a priority order: a due follow-up (post_message, then `followed_up`), today's things that need the user, new email and events, at most one finding a day, rarely one light line picking up yesterday's chat; otherwise `finish_checkin { nothingNeeded: true }`.
- Check-in instructions add: "What the user follows" (titles of non-archived tasks and routines, open plus resolved ones updated in the last 14 days, newest first, deduplicated, ≤ 20); "Findings you shared recently" (the `text` of the newest 7 ok `share_finding` steps, ≤ 200 characters each); "Follow-ups due now" (About-you facts); and, when share_finding would be refused, a line saying so.
- Follow-ups use `Memory.dueAt`. `remember` takes an optional `dueAt` (ISO 8601 with offset; with `replaces` the new row takes the call's value). A fact is due when it is active, `dueAt <= now` and `dueAt > now - 3 days` (older ones lapse silently). Prompt facts carry `dueAt` when set: `{ id, text, at, dueAt? }`. `MemoryFact` and the memory routes don't show it.
- `followed_up { factIds (1..5) }`, chat and check-in turns: clears `dueAt` on the user's facts this turn can read; others are listed as `skipped` (all unknown = error result).
- A chat turn answering a real user message (id not `turn_…`) that is the user's first message of their local day gets the follow-ups due now that the channel can read, with "mention one briefly if it fits, then call followed_up".
- Chat turns' capability brief adds a tone line: the answer first; one short question first only when the request is vague or a wrong guess would cost the user (sending, deleting, paying, booking); small talk in one short message of 1-3 sentences; no message only to say it got the request.

## M20

Contract: `backend/src/contract/m20.ts` (new shapes) plus additive fields on older shapes; samples: `docs/api-samples/m20.json`; migration `m20_safety`. Additive only: an app built before M20 decodes everything (older enums keep their values; every new field has a default), and older samples without the new fields still parse.

### Sign-in card (L141)

- `SignInMessage.payload` adds `step` `"credentials" | "code"` (default credentials), `reason` Phrase | null and `outcome` `"taken_over" | "dismissed"` | null. `state` keeps `pending | sent | expired | failed`.
- The card types the login through the computer's `/sign-in/fill` (the page must still be on the origin the user was asked to sign in to; a login that moves to another origin is not followed). When the site then asks for a one-time code, the card stays `pending` with `step: "code"`; a code the site refuses keeps it there with `reason` `signin.code_rejected`.
- `SignInCardResponse` (every action below) adds `step`, `reason`, `outcome` and `computer` (ComputerState | null, set by take-over). Submit answering `state: "sent", step: "code"` = the site wants a code next; signed in (after the password or after the code) answers `state: "sent", step: "credentials"`.
- Failure reasons (Phrase keys): `signin.wrong_page` {domain}, `signin.moved`, `signin.no_form`, `signin.rejected`, `signin.code_rejected`, `signin.failed`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /api/computer/sign-in/:requestId/code | SignInCodeRequest `{ code }` (body never logged) | SignInCardResponse; 400 when the card isn't at the code step |
| POST | /api/computer/sign-in/:requestId/take-over | – | SignInCardResponse `{ state: "expired", outcome: "taken_over", computer }`: the user now holds the browser |
| POST | /api/computer/sign-in/:requestId/dismiss | – | SignInCardResponse `{ state: "expired", outcome: "dismissed" }` |

Unknown or foreign request: 404 `not_found`; already used: 409 `stale_version`; past its 10 minutes: `state: "expired"`, as for the existing submit. Claude carries on after code (signed in), take-over (after the user hands back) and dismiss (told the user said not now).

### Browser approvals (#4)

- Before `computer_click`, `computer_type` with submit, or `computer_key` Enter, the server looks up the target's real name in its latest snapshot (and the page URL). A button that buys or pays, changes account or security settings, sends or posts, deletes, or submits a form, or a checkout page, posts an ordinary approval card (`kind: "action"`) instead of clicking: `preview.browser` `{ site, button, category: purchase | account | send | delete | submit, via: click | submit | enter }`, `why` `approval.why_<category>` (or `approval.why_checkout`). Approve runs exactly the stored call; Claude takes a fresh snapshot before going on.
- This check is separate from ToolPolicy: Always on Claude's computer (or a computer tool) doesn't skip it. Only an Always chosen on such a card does, and only for that site and category; `purchase` and `account` never offer one.

### Approval cards

- `Approval` adds `why` (Phrase | null, "Why am I asked?"; browser cards as above, a connector card of a safety-floor tool `approval.why_floor`) and `always` (`ApprovalAlways | null`): what Always on this card would cover, `{ scope: "recipient", value: "<addresses, lowercased, sorted, ', '>", category: null }` for a tool that sends to other people, or `{ scope: "site", value: "<site>", category }` for a browser card. Null = no Always row on the card.
- `ApprovalDecisionRequest` adds `always?: boolean`. Approve with `always: true` also stores the rule (ApprovalRule); later calls in that scope run without a card. 400 `validation_failed` when the card's `always` is null, or on decline.
- The same call (same tool and arguments, ignoring snapshot ids and refs) while its card is pending posts no second card; the model is told it's already waiting. One the user declined is refused without a card until the user writes again in that thread, at most 24 hours; the model is told it was the user's decision.

### Ask / Always pickers

- `ConnectorTool` and `CustomConnectorTool` add `alwaysAllowed` (default true) and `alwaysBlocked` `"floor" | "per_recipient"` | null. `floor`: payments, credentials and security settings always ask. `per_recipient`: it sends to other people; Always is chosen on its card for one recipient.
- `PUT /api/connectors/:toolkit/policy`, `/api/computer/policy`, `/api/custom-connectors/:id/policy` with `mode: "always"` for such a tool: 400 `always_not_allowed`. "All tools" (`tool: null`) skips them. A stored Always on such a tool (or on its toolkit) now reads as Ask.

### Claude's computer as an optional deploy

- `Features` adds `computerMode` `"off" | "headless" | "headed"` (off = not deployed; `computer` stays as it was) and `computerIdleMinutes` (the browser closes after this many idle minutes, from `COMPUTER_BROWSER_IDLE_MS`; null = never).
- Not deployed: `./scripts/setup.sh --computer off` adds `compose.no-computer.yml` to `COMPOSE_FILE`; computer and egress don't start (their volumes stay) and the backend runs with `COMPUTER_URL` empty.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | /api/computer/sleep | – | ComputerControlResponse (browser `off`); 409 `computer_busy` while Claude is using it or the user is in control |

- Waking: opening the full-screen view (the stream) or any computer tool wakes the browser, as before; a woken browser with no page opens a start page (`https://www.bing.com/`, or `COMPUTER_START_URL` in `backend/.env`).
- After Take over, 10 minutes with no input from the user hands the browser back to Claude, with a system line `computer.auto_handback` {minutes} in the thread that asked. The app hands back when the full-screen view is closed (✕ or swipe down); leaving the app doesn't.
- A Make build that waits for the user to hand the browser back and gives up fails with `artifact.user_in_control`. While the user holds the browser, reading and listing workspace files no longer wait; a write is tried first and waits only when the computer refuses it (unpatched agent-computer refuses `/files/write` and `/exec` while a person has control; since M20b our image lets `/files/write` through, `computer/patches/0005`); `computer_exec` still waits.

### Model-side limits (no new routes)

- Background turns (brief, check-in, scan) only read: writes, cards and computer tools are refused before they run, with a note pointing to add_up_next / propose_task. `web_fetch` there only opens hosts from that turn's `web_search` results. Routines are not background turns.
- A connector call (Composio, custom MCP or API) whose arguments carry a credential (password / token / key fields, Authorization values, known key formats) is refused before anything is sent and before any card is posted; the model gets the category and path, never the value.
- Content from outside (web pages, files, command output, connector and API results) reaches the model inside an `untrusted_data` envelope.
- `update_approval` on a browser card answers `not_editable`. `PUT /api/custom-connectors/:id/policy` answers `always_not_allowed` (field `mode`) like the other policy routes. A task session's turn prompt isn't a user message, so a call declined in a task stays declined there (up to 24 h) until the user replies in that task.

## M20b

No new shapes, routes or migrations. Claude's computer can show its whole Chrome window (tab strip, address bar, the mouse) instead of only the page:

- `WS /api/computer/stream`: in window mode (`COMPUTER_BROWSER_MODE=headed` with the M20b image) the binary frames are JPEGs of the whole virtual screen (portrait, about 860×1600 before scaling) and `frame_meta` carries that size. Headless mode is unchanged (frames are the page). Clients lay out by `frame_meta`'s aspect ratio; a portrait frame in a landscape box is fitted to the box width, top-aligned and cropped at the bottom.
- Input messages from the phone are unchanged (0...1 fractions of the frame). In window mode they are fractions of the whole window, so a tap can reach a tab, the ✕ of a tab or the address bar.
- The image (`computer/Dockerfile`, upstream OpenBot `da9a3ca` + `computer/patches/`) also has git and python3 in /workspace's shell.
- Patch 0005: `computer_files_write` no longer waits while the user holds the browser (a workspace write reaches neither the browser nor its profile); `computer_exec` and the browser tools still wait.
- The deploy default stays `headless` (measured: sites behind Cloudflare let the headed browser through far less often; PROGRESS M20b). Window mode is `setup.sh --browser headed`; `COMPUTER_BROWSER_SCREEN=portrait|landscape` (setup.sh `--browser-screen`) picks 860×1600 or 1280×800. The app reads `features.computerMode` as before.

## M21

Reliability. Shapes in `backend/src/contract/m21.ts`; samples in `docs/api-samples/m21.json`; migration `m21_reliability` (additive: `Artifact.startedBy` TEXT NOT NULL DEFAULT 'user', `Task.lastNotifiedStatus` TEXT NULL). Every new field has a default, so an app built before M21 decodes everything.

- **`RunRef.kind`** (status, typing, done): the run's `RunKind`. The app ends only the run of that kind: a build's `done` no longer clears the chat's typing dots. Events stored before M21 replay with `kind: null`.
- **`activeRun`** on `Channel` and on `MessagePage` (`{runId, kind, startedAt}`, null when nothing runs): the turn running, or queued first, in the channel's own thread (chat, and the channel turns of a routine). A cold start restores the typing dots and Stop from it.
- **`channel` event when Claude posts**: every new Claude or system line in a channel's own thread is followed by a `channel` event with the channel's new `unreadCount` (the shape is unchanged; before M21 it went out only on edits and mark-read).
- **`POST /api/channels/:id/read`**: body `{messageId}` (the newest message the user saw) and/or `{at}`. With `messageId` the read marker is that message's own `createdAt` (unknown or another channel's message: 400 `validation_failed`, field `messageId`). With `at` alone (older apps) the server adds 1 ms, so a time that lost its last digit in the app still covers the newest line. The marker only moves forward, as before. Body with neither: 400.
- **`resync` event** (`{reason: "replay_limit" | "pruned"}`), only on `GET /api/events`, never stored: the stream would have to replay more than `RESYNC_REPLAY_LIMIT` (2000) events, or the Last-Event-ID is older than what the server keeps. Its envelope `id` is the newest stored event id: the app reloads channels, the open thread, tasks and approvals, takes `id` as its Last-Event-ID, and keeps reading the same stream. Older apps ignore the type.
- **Artifact event `editStatus` / `refreshStatus`** (`ArtifactWorkStatus` `{state: "working" | "failed", reason}` or null): while Claude edits an existing page (from the viewer or the chat) or refreshes it, the artifact keeps `status: "ready"` and these say what is going on; `failed` carries the reason (`artifact.user_in_control`, `artifact.page_shrank`, `artifact.not_finished`, ...). Both go back to null once the page is saved.
- **`Artifact.startedBy`** (`user` | `assistant`, server only): who started the first build. Retry rebuilds in place (same artifact) with that trust level.
- i18n (phrases): `artifact.page_shrank`, `artifact.edited` {title}, `artifact.refreshed` {title} (en / zh-Hans; the String Catalog has the same text).
- **Quick replies**: a quick reply (`SendMessageRequest.quickReply`) on a card already chosen, or on a card the user has written after in its thread, is 409 `conflict` (field `quickReply`); nothing is stored.
- **`notification` event `collapseId`** (null on events stored before M21): one id per thing (`task-<id>`, `approval-<id>`, `message-<id>`), the same as the remote push's collapse id. Routes may name the line to open: `duet://channels/<id>?message=<messageId>`, `duet://tasks/<id>?message=<messageId>`.
- **Push** (no other shape change): APNs `apns-collapse-id` = the collapse id (a newer push for the same thing replaces the older one) and `collapseId` in the payload. Deep links name the line (alert cards, task results, reminders, chat approvals; a task's approval card opens the task); task pushes stay `duet://tasks/<id>`. An approval decided after its push went out: APNs gets a silent push `{aps:{content-available:1}, withdraw:["approval-<id>"]}` and the app removes that delivered notification; ntfy and Bark can't withdraw. In the user's quiet hours, task ready / needs input pushes, alert cards and task results are passive (APNs `interruption-level: passive`, no sound; ntfy `Priority: 2`; Bark `level: passive`); approvals, the user's own reminders, the brief and computer checks are not. A task still needing the user 2 h after its push, and a pending approval 2 h old, get one more push (same text and collapse id); a task's waits for the end of quiet hours.
- **Streaming in the log**: once a message has had no new version for 30 s (or has more than 50 stored versions) its superseded `message` events are deleted; the newest stays, so a replay after a finished reply carries it once, with its final text. Live streams still get every version.
- **Brief once a day**: a scheduled brief is skipped (Run `skipped`) when a brief already completed or resolved that local day (Run now included) or that day's first-day scan did.
- **Runs**: a tool call that runs past its limit is abandoned (error result to the model, a warning in the log): 5 min by default, `computer_exec` its own timeout + 90 s, other computer tools 15 min, `run_skill_script` 390 s, `execute_app_tools` 2 min per call. Stop no longer waits for a hung tool. A chat approval (no task) that is decided continues the chat with a server note, like a task's. Marking a task done (`resolved`) cancels its running turn. The history names earlier attachments (`[Attached: "Q3 report.pdf" (application/pdf)]`) and marks a reply cut off by Stop.
- **Make tools**: `refresh_artifact(artifactId)` (↻ from the chat, Claude's trust; on success the chat gets `artifact.refreshed` {title}). `edit_artifact` from the chat ends with `artifact.edited` {title} on success. Edit and refresh builds also get `edit_page(old_string, new_string, replace_all?)`. `finish_build` refuses an edit or refresh whose page is under 50 % of the old one in both markup and visible text (old page at least 4,000 characters of markup; `edit_page` deletions credited); the build then fails with `artifact.page_shrank`. The page written back for an edit never keeps the code the server injects when it serves a page. Retry = `POST /api/artifacts/:id/refresh` on a failed first build (same artifact); every refresh runs with the lower trust of the caller and `Artifact.startedBy`. `editStatus` / `refreshStatus` live in the server's memory: after a restart or `resync` the app treats a `working` it still shows as gone.

## M22

Tasks say what they need, Needs you, Setup, and setting up "who Claude is" in the chat. Shapes in `backend/src/contract/m22.ts` (plus `NeedsYou` in `tasks.ts`, the `group` block and `soul_setup` in `messages.ts`); samples in `docs/api-samples/m22.json`; migration `m22_tasks_soul` (additive: `Task.nextStep` / `failure` / `routinePausedBy` / `routineState` TEXT NULL, `Task.resolvedAt` DATETIME NULL backfilled from `updatedAt` for resolved tasks, `Task.routineFailStreak` INTEGER NOT NULL DEFAULT 0, `User.soulIntroAt` DATETIME NULL). Every new field has a default, so an app built before M22 keeps decoding; it sees fewer old resolved tasks and skips the new block and kind.

- **`TaskSummary.nextStep`** (`{kind, text, messageId}` or null): the one thing the task waits on the user for, shown on the row in place of the latest update. kind: `answer` (ask_user), `form` (ask_form), `approve` (a pending approval of the task), `sign_in`, `connect`, `review` (ready_for_review), `retry` (a failure), `reply` (reopened). `text` is a `task.next.*` phrase; `messageId` is the card in the task's thread to scroll to (null for review / retry / reply). The server keeps it current whenever the task's status, cards or failure change.
- **`TaskSummary.failure`** (`{reason, retryable, at}` or null): the last run failed. The status stays `needs_input` and the failure is still an update row, so older apps show it under Waiting on you. Cleared by Retry, a new message in the task, or a run that ends well. `retryable: false` when running it again the same way can't help (e.g. `system.no_model`).
- **`TaskSummary.resolvedAt`**: when it was last resolved (null otherwise).
- **`TaskSummary.app`**: the app of the suggestion the task was started from (Up next or proactive), e.g. "Gmail", so the row says "From Gmail"; null otherwise (`source` still says user / proactive). Migration column `Task.sourceApp` TEXT NULL.
- **`Routine.failStreak` / `pausedBy`** (`user` | `failures` | null): failed runs in a row, counted across days (a single run's own retries count once). At `ROUTINE_FAIL_LIMIT` (3) the routine pauses itself (`pausedBy: "failures"`, update `task.routine_paused_failures` {count}) and stops posting failure cards. `PATCH {paused: false}` resumes it and resets the count. A run that ends well resets it too.
- **`GET /api/tasks`**: every unfinished task plus those resolved in the last `RESOLVED_KEEP_DAYS` (7), and `olderResolved` (how many resolved tasks are older; archived ones never count). `?resolved=older[&cursor=][&limit=1-100, default 30]`: only those older resolved tasks, newest `resolvedAt` first, with `nextCursor` (null on the last page). `?q=<text>`: every unarchived task whose title or prompt contains the text (case-insensitive), any age, newest first, at most 100. `channelId` scopes all three. Bad `resolved` / `cursor` / `limit`: 400 `validation_failed`.
- **`POST /api/tasks/:id/retry`** -> `TaskDetail`: runs the failed turn again (failure cleared, status `working`). 409 `not_retryable` (no failure, or not retryable), 409 `task_running` (a turn of it runs).
- **`POST /api/tasks/:id/reopen`** -> `TaskDetail`: a resolved task goes back to `needs_input` with nextStep `reply` and the update `task.reopened`; nothing runs until the user writes. 409 `not_resolved` otherwise (a routine never resolves).
- **`POST /api/up-next`** (body `SaveForLaterRequest` = `{prompt, channelId}`, the + sheet's "Save for Up next") -> 201 `SaveForLaterResponse {suggestion}`: keeps the request as an Up next suggestion instead of starting it (title: its first line, at most 80 characters; body: the whole request; `origin: "chat"`, new `Suggestion.fromUser: true`; scans never hide or replace it). Start it later with `POST /api/up-next/:id/add`.
- **`GET /api/needs-you`** -> `NeedsYou {count, items}`: everything waiting on the user, newest first. Tasks with a `nextStep` (their questions, approvals and sign-ins count once, as the task) and the cards outside any task: open approvals, forms, sign-in and connection requests in the chat and channels (`{kind, messageId, channelId, title, detail, route, at}`, route `duet://channels/<channelId>?message=<messageId>`). `count` = `items.length` and is the Tasks tab badge. The app refetches it after `task`, `message`, `approval` and `resync` events.
- **`GET /api/setup`** -> `SetupInfo {items}`: one row per server dependency (`model`, `search`, `apps`, `computer`, `push`, `voice`): status `ready` | `not_checked` (set up, not tried since it changed) | `needs_setup` (with why), `required` (only the model), `fix` (`{kind: "route", route}` for an in-app page: `duet://settings/models`, `duet://settings/apps`, `duet://settings/voice`, `duet://computer`; `{kind: "env", names, hint}` for backend/.env variables the app can't change) and `checkedAt`. Never a secret's value. The phone's notification permission is the app's own row. **`POST /api/setup/check`** tries each set-up row (a tiny model call, a search, the computer's health, the push provider's config) and answers the same shape; rate-limited (429 `rate_limited` with a `Retry-After` header within 30 s of the last check).
- **Card `group` block** (`{type: "group", title, count, empty, rows: [{title, detail, route}]}`, at most 5 rows): a counted group the server builds from real data. Row routes: `duet://tasks/<id>`, or `duet://suggestions/<id>` (an Up next suggestion: tapping starts it with `POST /api/up-next/:id/add`, then opens the new task). Older apps skip the block.
- **`show_tasks` tool** (chat and channels): when the user asks how their tasks are going or what waits on them, Claude calls it and the server posts a `card` built from real data: groups Needs you / Working / Suggested / Done (last 7 days), each at most 5 rows, an empty group gets one line. Claude never writes the numbers itself.
- **`soul_setup` message** (`{fields: [{field, current, proposed}], reason, state}`; fields from name, addressAs, identity, persona, tone; state `open` | `applied` | `dismissed` | `superseded`): the end of setting up "who Claude is" in the chat (tool `propose_soul_setup`). `POST /api/messages/:id/action` `apply` writes every field at once (as `PUT /api/soul`), `dismiss` changes nothing. A new card in the same channel turns an open older one `superseded`. `propose_soul_change` (one field) stays for small changes.
- **Setting up "who Claude is" in the chat**: asked once per person (`User.soulIntroAt` is set when it starts). New user: in the turn after they answer the first-day scan (Sounds right / Something's off, or their first message when the app wasn't connected for it), after handling what they said. Existing user with fewer than 3 of the 5 soul fields set and no `soulIntroAt`: at the end of their next chat turn, one line of invitation with quick replies. One question at a time, at most 3 rounds (what to call you, what Claude calls itself, tone and character), each with 2–3 quick replies; "use the default" skips. Then Claude reads it back and posts a `soul_setup` card.
- **`POST /api/soul/intro`** -> 202 `SoulIntroResponse {channelId, runId}`: Everything → Who Claude is → Set up in chat starts the same setup in the main thread (queued behind a turn already running there); sets `soulIntroAt` if empty.
- i18n (phrases): `task.next.answer` {question}, `task.next.form` {title}, `task.next.approve` {summary}, `task.next.sign_in` {site}, `task.next.connect` {app}, `task.next.review`, `task.next.retry`, `task.next.reply`, `task.failed.unknown`, `task.reopened`, `task.routine_paused_failures` {count}, `setup.{model,search,apps,computer,push,voice}.title` (en / zh-Hans; the String Catalog has the same text). Workstreams add the `setup.*` detail and hint phrases they use the same way.

## M23

Proactive quality and chat interaction. Shapes in `backend/src/contract/m23.ts`; samples in `docs/api-samples/m23.json`; migration `m23_suggestions` (additive: `Suggestion.titleKey` / `sourceRef` / `messageId` TEXT NULL, `Suggestion.hiddenAt` DATETIME NULL backfilled from `updatedAt` for hidden ones, `Memory.sourceRef` TEXT NULL). Every new field is nullable or optional, so an app built before M23 keeps decoding.

- **`SourceRef`** (`{app, kind: email | event | doc | chat | web, title, at}`): where something Claude wrote in the background came from, for display ("From Gmail · Re: Q4 budget"). The database keeps the email / event id with it; the API never sends that id.
- **`MemoryFact.sourceRef`**: set on facts saved in the background from an email, event or page (null for facts from the chat or typed by the user). When the facts are put into Claude's context, a fact with a source is marked with it, so Claude can say where it knows it from.
- **`Suggestion.sourceRef`**: the email or event an Up next suggestion came from. `app` stays the app's name.
- **One suggestion, one answer**: `proactive_suggestion.suggestionId` and each `task_suggestions` item's `suggestionId` name the Up next row for the same item (null on older cards). `propose_task` / `propose_tasks` create (or reuse, see dedupe) that row. Start or Hide on the card updates the row (status added / hidden), and Add or Hide in Up next updates the card (state started / hidden, `taskId`), with a `message` event for the card. A second Start of the same item returns the task it already made (no second task).
- **Up next dedupe** (`backend/src/suggestions/dedupe.ts`, `checkSuggestion`): titles are compared normalised (`titleKey`). A suggestion is not created when an open or added one has the same key (the existing id is reused), when the user hid the same one within `HIDDEN_SUGGESTION_DAYS` (14), or when it names an email / event this turn didn't read.
- **Triage** (check-ins and the brief): rules only decide "can wait"; everything else is classified by the model per email with a reason; what it can't classify counts as needs you.
- **`TextPayload.brief`** (`BriefInfo {unchecked: [app]}`, only on the morning brief's message): the sources it tried and couldn't read (not connected, or the read failed). The brief's text says so too ("I couldn't check Gmail"); it never reads as "nothing new" for a source it didn't read.
- **Quick replies** (server rules): 2–3 options (`QUICK_REPLY_MIN` / `QUICK_REPLY_MAX`), each at most `QUICK_REPLY_MAX_CHARS` (24) characters (a Chinese character counts as one); none on an open question, while an approval waits, in the brief, or in a turn that used `web_search` (its answer isn't in the model's context yet). The first-day "Sounds right" / "Something's off" stay. Options that break the rules are dropped; fewer than 2 left means no card.
- **Reading pages**: `web_fetch` first for reading a link, summarising or quoting; the browser (`computer_navigate`) only for a login, a page that needs JavaScript, or clicking, filling in or posting. A `web_fetch` result with very little text says the page may need the browser. A PDF link returns its text.
- i18n: phrases the workstreams add are listed in their reports and written with `.pi/tools/add_phrases.py`.

## M24

Make quality. Shapes in `backend/src/contract/m24.ts` (plus `ArtifactSummary.lastOpenedAt` in `artifacts.ts`, the checklist item's `id`, the `line_chart` block and the `check` / `uncheck` actions in `messages.ts`); samples in `docs/api-samples/m24.json`; migration `m24_versions` (additive: `Artifact.lastOpenedAt` DATETIME NULL, new table `ArtifactVersion(id, artifactId, html, sources, metrics, by, reason, prompt, createdAt)` with an index on `(artifactId, createdAt)`, deleted with its artifact). The migration backfills `lastOpenedAt = updatedAt` for every artifact that has a page, so older pages don't all show "Just made" at once, and writes each existing page as its first version (`reason: "create"`, `by` from `startedBy`), so the first edit after M24 can be undone. Every new field is nullable with a null default, so an app built before M24 keeps decoding; it skips the `line_chart` block and draws checklists read-only.

- **Versions**: every save of a page writes one `ArtifactVersion` row in the same transaction as the artifact: a first build or a Retry of it (`reason: "create"`, `prompt` = the artifact's request), an edit (`"edit"`, `prompt` = the change asked for; several queued edits folded into one build: joined with blank lines; at most 8,000 characters), a refresh (`"refresh"`, `prompt` null), a restore (`"restore"`, `prompt` null). The newest row is always the page as it is now. A save whose page is the same as the newest version's writes no row (an unchanged refresh doesn't use up a slot). `by`: `user` for what the user did in the app (Create, ✎ / Comment, ↻, Retry, restore), `assistant` for the assistant's tools in chat or a task (`make_artifact`, `edit_artifact`, `refresh_artifact`) and scheduled refreshes. This is display only; trust still follows `Artifact.startedBy`. The row also keeps `sources` and the save's chat-card `metrics` (server only). At most `MAX_ARTIFACT_VERSIONS` (10) per artifact; a save beyond that deletes the oldest. A build that fails or is stopped writes nothing. Each version is a full copy of the page (pages are at most 5 MB), so `duet.db` and backups grow with it.
- **`GET /api/artifacts/:id/versions`** -> `ArtifactVersionList {versions: [ArtifactVersion {id, artifactId, by, reason, prompt, createdAt}]}`: newest first, never the page itself. Empty while the first build hasn't saved a page. 404 for another user's artifact.
- **`POST /api/artifacts/:id/restore`** (`RestoreArtifactRequest {versionId}`) -> `ArtifactResponse`: the chosen version's page and sources become the artifact's again (change markers stripped: a restore never glows) and are saved as a new newest version (`reason: "restore"`, `by: "user"`). `updatedAt` moves on (content time), so the gallery shows it under Changed today. The title, pins and refresh schedule stay as they are. Artifact cards in chat show the restored version's metrics (kept as they are when that version has none), and an `artifact` event goes out. Restoring the newest version changes nothing (200, no new row), so a double tap is harmless. 404 `not_found`: the version isn't this artifact's, or it was dropped by the limit. 409 `conflict`: a build, edit or refresh of this artifact is queued or running (restore after it is done).
- **Undo** (the viewer's ⋯ menu): restore `versions[1]`, the one before the newest (`ArtifactVersionList.undoTarget` in the app). Offered when there are at least 2 versions. Because a restore is saved as the newest version, Undo right after an Undo puts the undone change back; to go further back, pick an older row in the Versions list. The app fetches the list when the menu or the sheet opens.
- **`ArtifactSummary.lastOpenedAt`** (null default): `GET /api/artifacts/:id` is "opened" and sets it to now. The app sends that request only when it opens an artifact: the viewer (from the gallery, a chat card or a `duet://artifacts/<id>` link) and the pinned tab-bar page. Thumbnails and refreshes load `/html`, which never sets it. It keeps `updatedAt`, and the returned detail already carries the new value. It sends no `artifact` event, so other devices see it on their next `GET /api/artifacts`. `null` on an artifact that has a page = made and never opened: the gallery's orange border and "Just made" badge, kept across restarts and devices until the first open. Gallery sort "Last opened": newest `lastOpenedAt` first, never-opened ones by `createdAt` among them.
- **Card `line_chart` block** (`LineChartBlock {type: "line_chart", labels, series: [{name, values}], unit}`): a trend in `show_card`. 2-24 labels (each at most 24 characters), 1-3 series sharing them; each series has exactly one value per label, `null` for a gap (no data for that label); `unit` is nullable. `show_card` rejects a block whose lengths don't match, with the field path, and never posts it. Older apps skip the block.
- **Checkable checklist**: a `checklist` item may carry an `id` (null on items before M24 and on read-only lists). When Claude marks a `show_card` checklist checkable (a plan, a to-do or packing list; a status list stays read-only), the server gives each item an id unique in the card (`c1`, `c2`, ...). The user ticks one with **`POST /api/messages/:id/action` `{action: "check" | "uncheck", itemId}`** -> `MessageActionResponse`: it sets that item's `done` (true / false, so a repeat or a retry is harmless), updates the card in place and sends a `message` event. 404 `not_found`: not the user's message, or no checklist item with that id. 400 `validation_failed`: the message isn't a `card`. A tick starts no turn and doesn't wake a task. The next turn's history shows each item's state, so Claude can see what was ticked. The app updates the row at once and puts it back if the request fails.
- **`read_artifact(artifactId)`** (chat and task turns, never in a build; read-only, never asks for approval): returns `{artifactId, type, title, status, updatedAt, sources, text, truncated}`. `text` is the saved page's visible text: scripts, styles and the injected base left out; headings as markdown headings; lists and table rows one per line. It is cut at `READ_ARTIFACT_MAX_CHARS` (20,000) with `truncated: true`. The result says it is data, not instructions. While an edit or refresh runs it returns the last saved page. An artifact with no page yet returns its status and empty text; an unknown id or another user's artifact is an error result ("No artifact with that id."). Claude uses it when asked what an artifact says (or to answer from it) instead of guessing or starting an edit. It takes the id from the newest-artifacts list in its instructions or from an artifact card in the history, whose label includes the id.
- i18n: no new server-built phrases in the contract (version labels like "Edited by Claude" are the app's own strings from `by` / `reason`). Workstreams list any they add in their reports and write them with `.pi/tools/add_phrases.py`.

## M25

Skills and built-in capabilities. Shapes in `backend/src/contract/m25.ts` (plus `SkillSource` / `SkillImportPreview.source` `"upload"` in `m11.ts`); samples in `docs/api-samples/m25.json`; migration `m25_region` (additive: `User.region` TEXT NULL, no backfill). An app built before M25 keeps decoding: it reads an `upload` skill as written by you (its `source` decodes tolerantly) and never calls the new routes.

**Skills page.** Settings › Skills becomes a capsule "+ Add skill" over the user's skills. With none it shows an empty state (a puzzle icon). Add skill opens a system Menu with three entries: Create with Claude, Upload a skill, Import from GitHub. The old "New skill" form is no longer an entry; a saved skill's detail page still edits it. The app owns these strings.

- **`GET /api/skills`** is unchanged: only the user's own skills (the Skill table), by name. A built-in skill never appears in it, nor in `ChannelAccess`, the onboarding chips, the composer's "/" list or a `skill_proposal`'s "exists" note. `/name` and `SendMessageRequest.skill` never name a built-in.
- **`POST /api/skills/upload/preview`** (multipart `file`) -> `SkillImportPreview` with `source: "upload"`, then `POST /api/skills/import` as for GitHub. The saved skills get `source: "upload"`, `sourceUrl: null`. The server decides what the file is by its bytes, not its name:
  - **a zip** (starts with `PK\x03\x04`, or `PK\x05\x06` for an empty one): a `.zip` or a `.skill` (skill-creator's package: a zip holding one `<name>/SKILL.md` folder). Read like the zip import (at most `SKILL_UPLOAD_MAX_BYTES` (20 MB), 200 entries, 20 MB unpacked; every folder with a SKILL.md is a candidate).
  - **a single SKILL.md**: UTF-8 text without NUL bytes, at most `SKILL_MD_UPLOAD_MAX_BYTES` (1 MB). One candidate with no other files. Its name is the frontmatter `name`, else the uploaded file name without `.md` (a file named `SKILL.md` gives none), normalised like an import. With no usable name it is 400 `validation_failed` field `file` ("SKILL.md needs a name in its frontmatter."); no body is 400 too.
  - Anything else: 400 `validation_failed` field `file` ("Upload a .zip, a .skill or a SKILL.md file."). Too large: 413 `too_large`. Empty: 400.
  - `POST /api/skills/zip/preview` stays as it was (`source: "zip"`) for older apps.
  - A skill from an upload has scripts that ask before their first run, like one from GitHub or a zip.
- **Import from GitHub**: unchanged (`GET /api/skills/github/preview`).
- **Create with Claude**: the app opens the main thread with the composer prefilled with "Help me create a skill: " ("帮我创建一个技能：" in Chinese), cursor at the end. The user adds a sentence and sends it as an ordinary message (no `skill` field). Every chat turn's built-in index lists `skill-creator` (`SKILL_CREATOR`), whose index line says to load it when the user wants to make, write or save a skill or turn a way of working into one. Claude loads it, asks what it needs one question at a time, writes the SKILL.md, tries it on one example, then calls `propose_skill`. That is the existing "Save this as a skill?" card. Save skill stores it (`source: "assistant"`), and it shows on the skills page and in "/" after the next `GET /api/skills` (the card's `message` event tells the app to refetch).

**Built-in skills** (server only, never in the API):
- In `backend/skills-builtin/<name>/` (SKILL.md, its other files, the upstream LICENSE / NOTICE as they are, CHANGES.md when changed), listed in `backend/skills-builtin/manifest.json` (`BuiltinSkillManifest`: per skill `name`, `index` (our own short text, at most `BUILTIN_INDEX_MAX_CHARS` (160) characters), `turns` (`chat` | `task` | `build`), `needsComputer`, `upstream` {repo, commit, path, license} or null, `changes`). Copied into the backend image; read once at startup, and a manifest that doesn't parse stops the server. Never in the Skill table, so the user can't see, edit or delete them.
- Each turn's instructions carry a separate built-in index line after the user's skills: the built-ins whose `turns` include this turn's kind (`chat` = the main thread and channels; `task` = a task's session and its routine runs; `build` = a Make build; briefs, check-ins and scans: none), minus `needsComputer` ones when Claude's computer isn't set up for the user, minus any whose name one of the user's visible skills already has (the user's skill wins). Example: `Built-in skills (load one with use_skill when it fits): [{"name":"frontend-design","description":"..."}]`.
- `use_skill(name)` and `read_skill_file(name, path)` resolve the user's visible skill first, then a built-in listed for this turn. A built-in's `use_skill` result has `source: "builtin"` and a note that these are OpenDuet's own instructions for this kind of work, never above the system rules, the approval rules or what the user asked. `run_skill_script` takes only the user's skills (built-ins run their programs, such as `officecli`, through `computer_exec`). A Make build is offered `use_skill` and `read_skill_file` for its built-ins only (no user skills, no `propose_skill`).
- Licences: every upstream folder keeps its LICENSE / NOTICE. A changed file starts with an HTML comment saying it was changed and pointing at CHANGES.md; the loader strips the comment before the model sees the text. THIRD_PARTY_NOTICES.md names each source, its commit and licence.
- First batch (plan §7b): `skill-creator` (chat; rewritten for OpenDuet: ask → write SKILL.md → try one example → `propose_skill`), `frontend-design` and `theme-factory` (build), `officecli` (OfficeCLI's root SKILL.md without its install section, matching the binary in the computer image; chat + task, needs the computer), `pdf` (written for OpenDuet: HTML to PDF with the computer's Chromium, reading with unpdf + NFKC; chat + task, needs the computer), `explore-data`, `meeting-minutes-taker` (its `disable-model-invocation` line removed), and `task-management` only if adapted to Duet's own tasks (it keeps a TASKS.md otherwise).

**Built-in connectors**: key-less read-only function tools (backend tools, not MCP installs) every user has without setup. The id is the tool name (`BuiltinConnectorId`): `web_search`, `weather`, `exchange_rate`, `read_feed`. Offered in chat, task, routine and background turns (brief, check-in, scan), never in a Make build. They never ask for approval. Their results go through M20's untrusted envelope. Status keys: `searching_web`, `looking_up` (weather, exchange_rate), `reading_now` (read_feed). Run step titles: `run.step.web_search`, `run.step.weather`, `run.step.exchange_rate`, `run.step.read_feed`. In a background turn, `read_feed` follows `web_fetch`'s rule: only hosts this turn's `web_search` returned. `weather` and `exchange_rate` call fixed hosts.
- **`web_search`**: `SEARCH_PROVIDER` adds `exa` and `parallel` (no key; they are called through their MCP servers' `tools/call`, `https://mcp.exa.ai/mcp` and `https://search.parallel.ai/mcp`). Unset = the key-less default: Exa first, and Parallel when Exa fails, times out or answers 429. `exa` / `parallel` = only that one. `tavily` / `brave` / `serper` / `searxng` work as before, with no fallback. `BUILTIN_CONNECTORS_OFF` containing `web_search` turns off only the key-less default. Then, with no `SEARCH_PROVIDER`, `web_search` isn't offered and the "isn't set up yet" rule applies. A provider set in `SEARCH_PROVIDER` always runs. `Features.webSearch` and Setup's search row count the key-less default (`setup.search.keyless` {provider, fallback}). The search words go to that company (Exa and Parallel are US companies); the tool description already forbids private data in queries.
- **`weather(place, days?, unit?)`**: `place` is a city or place name in any language; `days` is 1-`WEATHER_MAX_DAYS` (7), default 3; `unit` is `celsius` | `fahrenheit`, defaulting from `User.region` (`FAHRENHEIT_REGIONS`, else Celsius; Celsius when the region is unknown). The place is looked up with Open-Meteo's geocoding in the user's language (`User.language`: `zh` for zh-Hans, else `en`), and `User.region`'s matches come first. When the top matches are different places with the same name, the result lists up to 3 (name, admin area, country) so Claude can ask, unless one is a city (100,000+ people in Open-Meteo's data) at least 10x larger than each of the others and the user's own country has no other city of that name: that one gets the forecast (杭州 is Zhejiang's; London is England's, except for a user in Canada). The forecast is Open-Meteo's, in the place's own timezone. Result: `{place: {name, admin, country, latitude, longitude, timezone}, unit, current: {time, temperature, apparentTemperature, weather, windSpeed, precipitation}, daily: [{date, weather, high, low, precipitationChance, precipitation}], attribution: "Weather data by Open-Meteo.com"}`. `weather` is the WMO weather code in words, in the user's language: a mapping table in code for en and zh-Hans. Wind is km/h with Celsius and mph with Fahrenheit. Claude credits "Weather data by Open-Meteo.com" in its reply (Open-Meteo's CC BY 4.0). `OPEN_METEO_URL`, `OPEN_METEO_GEOCODING_URL` (defaults: the free API) and `OPEN_METEO_API_KEY` (sent as `apikey`; with it the connector is not `keyless`) allow the paid plan or a self-run Open-Meteo. The free API is for non-commercial use only; the README says so.
- **`exchange_rate(base, quotes, amount?, date?)`**: ISO 4217 codes (`base` one code, `quotes` 1-`EXCHANGE_RATE_MAX_QUOTES` (10)), `amount` > 0 (default 1), `date` YYYY-MM-DD (default latest). Frankfurter's rates (`api.frankfurter.dev`, ECB reference rates, working days). The tool multiplies the rate itself (Frankfurter's own convert rounds). Result: `{base, date, amount, rates: {CODE: rate}, converted: {CODE: amount × rate}, source: "Frankfurter (European Central Bank reference rates)"}`. An unknown code is an error result naming it. The rates are mid-market reference rates, not a bank's buy / sell rate, and the description says so.
- **`read_feed(url, limit?)`**: an RSS 2.0, RSS 1.0 (RDF) or Atom feed. Fetched with `web_fetch`'s guards (GET only, public addresses re-checked after DNS and on every redirect, at most 5 redirects, the size and time limits, the declared charset) and parsed as XML before any cut. Result: `{feed: {title, link}, items: [{title, link, published, summary}]}`, newest first, `limit` 1-`READ_FEED_MAX_ITEMS` (20), default 10. `summary` is plain text of at most `READ_FEED_SUMMARY_MAX_CHARS` (300) characters; `published` is ISO or null. A page that isn't a feed is an error result saying so (read it with `web_fetch`). Hacker News: hnrss.org feeds.
- **Switches** (`backend/.env`): `BUILTIN_CONNECTORS_OFF` = comma-separated ids to turn off on this server; an unknown id stops the server at startup, naming it. Turned-off tools aren't offered and the Environment section doesn't name them. There is no per-user switch: a built-in is on for every user of the server unless it is turned off there.
- **Can't be reached**: a call that can't reach its service (network error, timeout, 5xx, or 429 after the fallback) returns an error result saying the service can't be reached right now and to tell the user so, never guessing. The connector then reads `unreachable` until a call works again. It stays offered.
- **`GET /api/builtin-connectors`** -> `BuiltinConnectorList {connectors: [{id, state, providers, keyless, checkedAt}]}`: all four, in id order, off ones included. `state`: `on` | `off` (turned off in `.env`; for web_search, also when there is no provider at all) | `unreachable` (the last call failed). `providers`: who answers, in the order tried (`["Exa", "Parallel"]`, `["Tavily"]`, `["Open-Meteo"]`, `["Frankfurter"]`, `[]` for read_feed and while off). `keyless`: no key or account (false for a keyed SEARCH_PROVIDER or `OPEN_METEO_API_KEY`). `checkedAt`: the last call's time, kept in memory (null since the server started). No secret or URL is ever in it. The app shows these rows read-only under "Built in" on the connectors page (Settings › Apps and connectors), each with its own name, icon and a line saying what it sends where.
- **Featured** (`connector-templates/registry.ts` `FEATURED`): adds a few everyday servers, not only developer tools: only names that are in the official MCP Registry with a hosted remote when the list is written.

**X-Region**: from M25 every request also sends `X-Region`, the iPhone's region (ISO 3166-1 alpha-2, `Locale.current.region`; not sent when the region isn't a country, such as `001`). The backend keeps `User.region` in sync from it like `X-Timezone` (`RegionCode`: two letters, upper-cased; anything else is ignored). It is server only, not in `Me`. The weather tool uses it.

- i18n (phrases): `run.step.weather`, `run.step.exchange_rate`, `run.step.read_feed`, `setup.search.keyless` {provider, fallback} (en / zh-Hans; the String Catalog has the same text). The weather words are tool output for Claude, not phrases. Workstreams list any phrases they add in their reports and write them with `.pi/tools/add_phrases.py`.

## M26

The Files page: grouped by origin, delete (also a sent file, optionally its original on Claude's computer), the task working folder. Shapes in `backend/src/contract/m26.ts` (plus the new `ChannelFile` fields in `channels.ts` and `DeleteFileResponse` in `messages.ts`); samples in `docs/api-samples/m26.json`; migration `m26_files` (additive: `ChannelFile.origin`, `workspacePath`, `taskId` TEXT NULL, `deletedAt` DATETIME NULL, plus a one-time backfill). An app built before M26 keeps decoding: the new fields have null defaults, a deleted card is the same `file` / `image` kind (its preview gets 404, the app's usual "couldn't load" line), and its long-press Delete now succeeds on sent files too (only the chat's copy goes; the 200 body is ignored).

**File rows** (`ChannelFile`, wherever it appears: `GET /api/channels/:id/files`, file / image cards' `payload.file`, a text message's `attachments`, `UploadFileResponse`, `DeleteFileResponse`):
- `origin` (`FileOrigin`): `send` (send_file), `write` (computer_files_write shared it in the chat, L140), `screenshot` (a computer screenshot posted in the chat), `upload` (the composer). Every write path records it, approved calls too. A same-turn send_file of a path the turn already shared updates that card (M26 W1a) and the row becomes `send`. null = from before M26 with no match in the audit log. An app reads an origin it doesn't know as null.
- `workspacePath`: where the original lives in /workspace, relative to it (`build/build.py`; the `workspacePath()` form of computer/paths.ts, at most 1024 characters). send / write: the tool's path. upload: `uploads/<id8>-<safe name>` once the attachment copy into /workspace has succeeded (null before that, and for uploads before M26). screenshot: null.
- `taskId`: the task whose own session made the file (`TurnInput.taskId`; for an approved call, the approval's task). null for chat, channel and routine turns and for uploads. `taskTitle`: that task's current title (null without `taskId`, or once the task is deleted; cards keep the title from when they were posted). Not a relation: deleting a task keeps its files.
- `artifactId`: when `workspacePath` is `artifacts/<id>/...` and that artifact still exists for the user, its id; the Files row then opens the artifact (`duet://artifacts/<id>`) instead of the file preview. null otherwise.
- `deletedAt`: when the user deleted it (below). Only cards, attachments and the DELETE answer ever carry a deleted file; lists never do.

**Backfill** (once, in the migration): each of OpenDuet's rows takes the AuditLog row of the same user, actor `assistant`, outcome `ok`, less than 50 ms away, whose `target` names it (send_file / computer_files_write: the path equals the name or ends in `/<name>`; computer_screenshot: the name has the `<host>-YYYY-MM-DDTHH-MM-SS.png` form), the nearest one (ties: the smaller id). `origin` comes from the action, `workspacePath` from the target (none for screenshots), and `taskId` from the card's message (a task session's thread), else from the run when it was a task run. The user's rows become `upload` without a path. Rows that don't match keep nulls. On the 2026-10-29 backup all 23 rows matched: 18 task working files, 2 chat writes, 2 sends, 1 screenshot.

**Files page** (profile › Files and a channel sheet's Files; one rule for both). The list stays `GET /api/channels/:id/files`, newest first. The app sorts each row into one group by `origin` and `taskId`. Each group keeps the rows newest first and is hidden when empty. The groups, in order:
1. **Claude sent you**: `send`, and `write` without `taskId` (files Claude wrote while chatting, shared as cards).
2. **You uploaded**: `upload`, and rows with no origin whose `source` is `user` (an older server).
3. **Screenshots**: `screenshot`.
4. **One group per task** (`write` with `taskId`), newest task first. Collapsed by default. The header shows `taskTitle` and the count; tapping the title opens the task (`duet://tasks/<taskId>`), the chevron expands it. A task deleted since shows "Deleted task" and opens nothing.
5. **Other**: no origin and `source` `assistant` (unmatched older rows, or every row of a server before M26).

A `send` or `screenshot` made in a task stays in its own group (Claude handed it over, or it is a picture), with the task's title in the row. Each row's subtitle adds `workspacePath` when there is one. No folder tree of /workspace is shown.

**`DELETE /api/files/:id`** deletes any of the user's files, sent or not.
- Options: `alsoWorkspace` (default false), as `?alsoWorkspace=true|false|1|0` (`DeleteFileQuery`) or as the JSON body `DeleteFileRequest {alsoWorkspace}`. An empty body is fine. A body that isn't that object, or a query and a body that disagree, is 400 `validation_failed` field `alsoWorkspace`. The app sends the query (some proxies drop a DELETE's body), and nothing at all for false.
- Checks come first; when one fails, nothing is deleted:
  - 404 `not_found`: not the user's file, or already deleted (the app takes 404 as gone).
  - With `alsoWorkspace`:
    - no `workspacePath`: 400 `validation_failed` field `alsoWorkspace` ("This file has no original on Claude's computer.");
    - the path is under `artifacts/` or `.skills/` (`PROTECTED_WORKSPACE_DIRS`): **409 `protected_path`** (an artifact's page is deleted from the Make page; a skill's copy belongs to the skills page). The audit records it as denied;
    - Claude's computer isn't set up for the user: 503 `not_configured`;
    - it can't be reached or times out: **503 `computer_unreachable`**;
    - it refuses because the user is driving its browser: 409 `computer_busy` (M20's code);
    - the path is there but isn't a regular file (a folder, a symlink, it leaves /workspace): 400 `validation_failed` field `alsoWorkspace`.
- Then, in order:
  1. With `alsoWorkspace`, the original at `workspacePath` is removed. It is confined to /workspace with no symlink on the way, the same check as the workspace writes. Nothing at that path any more is fine: `workspace: "missing"`. Other rows of the same path (an earlier copy) are left alone.
  2. The bytes in FILES_DIR are removed.
  3. An upload never sent (no `messageId`) is deleted outright. Any other row stays as a tombstone with `deletedAt` set, so its card can say so.
  4. The message it is in is rewritten from the tombstone: a file / image card's `payload.file`, or a text message's `attachments` (read from the rows). A `message` event goes to that channel, so other devices show "Deleted" and drop the file from their lists. No new event type.
- After that, `GET /api/files/:id/content` is 404 and the lists leave the file out. The model's history shows the card as `[file "x.csv" (text/csv), deleted by the user]`, and an attachment as `"x.csv" (text/csv, deleted)`. A retry of an old turn leaves deleted attachments out. Derived task resources skip deleted file cards (links already saved in a task just fail to open).
- Audit: `file_delete` (actor `user`, target the file name, outcome ok), and with `alsoWorkspace` also `computer_files_delete` (target the path; ok, error, or denied for a protected path).
- Answer: 200 `DeleteFileResponse {file, message, workspace}`. `file` is the deleted file (`deletedAt` set, `taskTitle` / `artifactId` filled in). `message` is the card or text message as it now reads, or null for an upload never sent. `workspace` is `not_asked` | `deleted` | `missing`. Before M26 this answered 204, and 409 for any sent file.

**In the app**: long-press › Delete keeps its confirmation in place. It gains a switch "Also delete from Claude's computer", off by default, shown only when the row has a `workspacePath` outside `artifacts/` and `.skills/`. The preview's ⋯ menu gets Delete too. A deleted card shows the file name with "Deleted" and doesn't open. A deleted image bubble shows a placeholder and never loads the bytes. The app owns these strings.

**Task working folder** (M26 W1a): a task session's system prompt says its working files go in `/workspace/tasks/<taskId>/` and deliverables go to the user with send_file. Existing files aren't moved. Routines and chat turns don't get the line.

- i18n: no server-built phrases (the group titles, "Deleted", the switch and the refusals are the app's own strings; the history labels are for Claude).

## M27

Live dashboard data: a dashboard keeps its numbers apart from its page, so a chat, task or routine turn changes them without a rebuild and an open viewer shows the change within seconds. Shapes in `backend/src/contract/m27.ts` (plus `ArtifactSummary.pageUpdatedAt` / `dataVersion` in `artifacts.ts`, the version reason `data` and `ArtifactVersion.dataUpdates` in `m24.ts`); samples in `docs/api-samples/m27.json`; migration `m27_dashboard_data` (additive, no backfill: `Artifact.data` TEXT NULL, `dataVersion` INTEGER NOT NULL DEFAULT 0, `dataUpdatedAt` DATETIME NULL; `ArtifactVersion.data` TEXT NULL, `dataUpdates` INTEGER NOT NULL DEFAULT 0, `runId` TEXT NULL).

The user's decisions (2026-10-29): only dashboards get live data (docs, slides, web pages, designs keep today's whole-page refresh); the page stays HTML with today's look and still can't reach the network (`connect-src 'none'` stays); a task / routine / chat turn updates the data with a new tool and no approval; every update is in the version history and can be undone; an open viewer shows it within seconds without a reload or a rebuild; the 11 existing artifacts (none with data) behave exactly as before.

**Older apps.** Every new field has a default. A data update moves the summary's `updatedAt`, so an app built before M27 reloads the open page (which carries the new data) as it does after any change: live, with a reload instead of in place. It reads the version reason `data` as an unknown reason ("Changed by Claude").

### The data
- **Only dashboards.** `finish_build` and `update_artifact_data` refuse data on every other type. Why: the user's decision; a doc or a page has no numbers that tick.
- **Shape** (`ArtifactData`): one JSON object. At most `MAX_ARTIFACT_DATA_BYTES` (64 KB) as compact JSON (UTF-8 bytes of `JSON.stringify`), values at most `MAX_ARTIFACT_DATA_DEPTH` (8) levels below the top, keys 1-200 characters and never `__proto__` / `prototype` / `constructor`, finite numbers only. Anything else is refused, never trimmed. Why 64 KB: a dashboard shows counts, a few series and a capped list; 64 KB is room for that plus a 1,000-row list of short items, and the whole object still fits a model's tool call and one fast fetch on a phone. The forbidden keys keep a page's `obj[key] = ...` code and the server's ops away from prototypes.
- **Stored** in `Artifact.data` as compact JSON text, keys in the order given. The page must not depend on object key order (JS reorders integer-like keys anyway): anything ordered is an array. The stored page (`Artifact.html`) never holds the data.

### How the page reads it
- **At load** (`GET /api/artifacts/:id/html`: the viewer, the thumbnails, the 4th tab, Share): a dashboard with data is served with two blocks right after the base's head blocks (after `<script data-duet-base data-duet-charts>`), before any of the page's own scripts:
  - `<script type="application/json" id="duet-data" data-version="N" data-duet-base>` + the JSON with every `<` written as `\u003c` + `</script>` (`DATA_ELEMENT_ID`, `DATA_VERSION_ATTR`);
  - `<script data-duet-base data-duet-data>` + the data runtime + `</script>`.
  Both are composed at serve time, never stored. Why: a data update then never rewrites the page, page and data stay apart in versions too, and every pre-M27 page is served byte for byte as before (a page without data gets neither block). `stripInjected` drops both (they carry the base marker), so a copy never ends up in a stored page.
- **The runtime** (base code, CSP-safe inline): `window.duetData` = the parsed object; `window.duetOnData(fn)` calls `fn(data)` at once and again after every newer version. It re-reads the element when the app fires `duet:data` on `document` (`DATA_EVENT`) and when the element's `data-version` changes (a MutationObserver, so it works whichever content world wrote it). It never trusts the event's detail, skips a version it already rendered, keeps the last good data when the JSON doesn't parse, and catches each `fn`'s errors. A page whose scripts call `duetOnData` must call it after its own elements exist (a script at the end of `<body>`), and guard with `if (window.duetOnData)` (a restore can bring back a version without data).
- **Live, in the app**: the app sets the element's text to the new JSON and its `data-version` to the new number, then fires `new Event("duet:data")` on `document`, only when the number is higher than the element's. `ArtifactLiveData` in `M27Models.swift` has the three names.

### The event and the fetch
- **No new event type.** The data change sends the existing `artifact` event (`buildStatus` as it is now, statuses as they are now) whose summary carries the new `dataVersion` and `updatedAt`. Why: the summary is what every consumer already upserts (gallery, cards, viewer); the contract host still counts 16 event types. The event never carries the data: a 64 KB payload at up to 20 updates a minute would fill the replay log and every reconnect; the fetch below is the one place it comes from, also after a missed event.
- **`GET /api/artifacts/:id/data`** -> `ArtifactDataResponse {artifactId, dataVersion, dataUpdatedAt, json}`. `json` is the stored text as is (the same bytes the page carries, so key order and number forms never change on the way), null when there is no data. 404 for another user's artifact. Not an "open": it doesn't set `lastOpenedAt`.
- **`ArtifactSummary.updatedAt`** is content time: the later of the page's save (`pageUpdatedAt`) and the data's last change. Why: a dashboard whose numbers changed has changed for "Updated now", Changed today, Last modified and thumbnails, and an older app then reloads. **`pageUpdatedAt`** (new) is the page's own save time: a build, an edit, a page refresh, a restore that changed the page or its sources; data-only writes keep it. **`dataVersion`** (new): +1 on every data change; 0 = never had data.
- **The viewer**: a newer `pageUpdatedAt` reloads the page (as `updatedAt` does today); a newer `dataVersion` alone fetches `/data` and hands the JSON to the open page, no reload. An older server sends no `pageUpdatedAt` (`ArtifactSummary.pageVersion` falls back to `updatedAt`).
- **Thumbnails** keep their key (`updatedAt`): it moves with every data change, because the server keeps content time strictly increasing (a data change's `dataUpdatedAt` is at least the previous content time + 1 ms). Why: no new disk-cache file format, and the snapshot the `/html` page renders already carries the data. The app re-renders a thumbnail whose only change is data at most every 30 s while it is on screen (the old snapshot stays meanwhile), so a task updating every few seconds doesn't keep a web view busy.

### `update_artifact_data`
| tool | turns | access | default mode | approval | run step |
| --- | --- | --- | --- | --- | --- |
| `update_artifact_data` | chat, task, routine (also without Claude's computer) | write | always (not in any Ask / Always picker, like `make_artifact`, `edit_artifact`, `show_card`) | never | `run.step.artifact_data` "Updated dashboard data" / 「更新仪表盘数据」, status key `working` |

- **No approval**, as the user decided, because: it changes only the user's own artifact, sends nothing to anyone and reaches no network (the page still can't), every saved update is a version the user can undo, and it is the same kind of write as M24's checklist ticks. **Not offered** in a brief, a check-in or a scan (not in `BACKGROUND_TOOLS`, so the read-only guard refuses it even if called: a background turn has no task that feeds a dashboard), in a Make build (a build seeds its own artifact's data with `finish_build`'s `data`; it must not change other artifacts), or in a voice call (its four tools are fixed).
- **Arguments** (`UpdateArtifactDataInput`, strict): `artifactId`; exactly one of `ops` (1-50 `DataOp`, in order, all or nothing) or `data` (the whole object, replacing it); `expectedVersion` (optional: the `dataVersion` the call was written against); `metrics` (optional, 2-4 `{label, value, unit}`: the chat card's numbers after this change).
- **Ops** (`DataOp`; `path` = 1-8 segments, a string key or an array index):
  - `{op: "set", path, value}`: any JSON value at `path`;
  - `{op: "increment", path, by = 1}`: adds `by` (may be negative) to the number there (missing = 0);
  - `{op: "append", path, value, max?}`: adds to the end of the array there (missing = []); `max` (1-1000) keeps the newest `max` items;
  - `{op: "remove", path}`: deletes the key or the array item (missing = nothing to do).
  Missing objects on the way are created for set / increment / append; an array index must exist (append adds items). The result must be valid data (above). Why path ops: a scrape task changes a few counts and appends a row per batch; resending a 30 KB object each time costs tokens and invites mistakes. `data` stays for a first fill or a reshape.
- **Result** (`UpdateArtifactDataResult`): saved `{status: "updated" | "unchanged", artifactId, title, dataVersion, bytes, note}`. `unchanged`: the ops left the data as it was; nothing is saved, no event, no version, `dataVersion` as before. Refused (`isError: true`) `{error, code, dataVersion, retryAfterMs}`, nothing saved, codes (`DataRefusalCode`):
  - `not_found`: no artifact with that id for this user;
  - `not_dashboard`: another type (use edit_artifact / refresh_artifact);
  - `no_data`: a dashboard without data (built before M27, or restored to a version without data): its page doesn't read data; refresh_artifact, or edit_artifact to rebuild it on live data;
  - `not_ready`: no page saved yet (building, or its first build failed): try again once the card is in the thread;
  - `version_conflict`: `expectedVersion` isn't the current `dataVersion` (returned): read_artifact again and redo the change;
  - `too_large`, `invalid_data`, `invalid_op` (an index past the end, increment on a non-number, append on a non-array, a path through a value): the message names the op and the path;
  - `too_frequent`: more than `DATA_UPDATES_PER_MINUTE` (20) saved updates of this artifact in the last 60 s (no-ops don't count; `retryAfterMs` says when). Why 20 / minute and no minimum gap: a scrape updates per batch, every few seconds at most; two updates in one round must both go through; a looping model must not flood the event log and every open phone.
  - Argument errors (zod) answer `Invalid tool arguments` with the issues, as every tool does.
- **A saved update** (one transaction, under the artifact's content lock, so it orders with restores and build saves): `Artifact.data` = the new text, `dataVersion` +1, `dataUpdatedAt` = max(now, the previous content time + 1 ms), the row's `updatedAt` kept (the page didn't change); the version row (below); then the `artifact` event, and every chat card of the artifact gets the new summary (and `metrics` when given) as a `message` event. It may run while an edit or refresh build of the same dashboard runs: the update saves; when that build saves its own data afterwards, the build's data wins (its new version can be undone).
- **`read_artifact`** adds `dataVersion` and, for a dashboard with data, `data` (the parsed object; inside the untrusted-data envelope like the rest). Claude reads it before its first update of a dashboard in a turn. The newest-artifacts list in the chat / task instructions marks a dashboard with data `liveData: true`.

### History (versions)
- Every saved data update is in the version history, with `reason: "data"`, `by: "assistant"`, `prompt` null, its `data`, and the page, sources and metrics as they are. **Merging**: an update merges into the newest version when that row is `reason: "data"`, has the same `runId` and was created less than `DATA_VERSION_MERGE_MS` (10 min) ago. It then becomes that row's `data` / `metrics` and its `dataUpdates` +1; `createdAt` stays the first update's. Otherwise a new row (`dataUpdates: 1`). Why: a scrape task's dozens of updates become one undoable step per run per 10 minutes, and Undo right after a task undoes what that task did.
- **Limits**: still `MAX_ARTIFACT_VERSIONS` (10) per artifact, at most `MAX_DATA_VERSIONS` (4) of them `data` rows. A new `data` row first drops the oldest `data` rows beyond 4; if that still leaves more than 10, the oldest row goes, as for any save. A page save (create, edit, refresh, restore) drops the oldest row beyond 10, as in M24. So data updates can never take more than 4 slots, and at least 6 page versions stay.
- **Dedupe**: as in M24, a save whose page equals the newest version's writes no new row (that row's sources and metrics are updated in place), now only when its data is equal too; different data is a new row. M24's restore no-op check (a repeated tap) compares the data too.
- **Restore / Undo** (M24's routes and rules) bring back the chosen version's page, sources, data and metrics together. The data changes only when it differs: then `dataVersion` +1 and `dataUpdatedAt` moves. The row's `updatedAt` (`pageUpdatedAt`) moves only when the page or the sources differ, so restoring a data-only version updates the open page in place, and anything else reloads it. A version saved before M27 has no data: restoring it on a dashboard that has data clears the data (`no_data` afterwards, until an edit rebuilds it on data).

### Builds
- **`finish_build` gains `data`** (`ArtifactData`, nullable): a dashboard's first build (and its Retry) must pass it (else the error says so and nothing is saved). An edit may pass it (replaces the data; omitted = kept); that is also how a dashboard without data becomes a live one. A dashboard refresh with data must pass it (below). Any other type passing it is refused. Saved with the page in one transaction: `dataVersion` +1 when the data differs.
- **Edit and refresh builds** also find the current data as `/workspace/artifacts/<id>/data.json` (written by the server before the run, pretty-printed; reference only: what is saved is `finish_build`'s `data`).
- **What a dashboard build is told** (prompt text W2 writes): keep every number, row and label that can change in one JSON object passed as `finish_build`'s `data` (at most 64 KB; anything ordered as an array; no object keys that matter for order), and render it from `window.duetData` with `if (window.duetOnData) duetOnData(function (data) { ... })` in a script at the end of `<body>` that redraws everything that depends on the data each time it is called (an update arrives while the page is open). Never write those values into the HTML itself. Use `textContent` (or the base's escaping) for any text from the data, never `innerHTML`: it may come from scraped pages. The page's title, headings, layout and notes stay in the HTML. `duetBars(el, data, opts)` may be called again with new data (it redraws in place). `metrics` are checked against the numbers in `data` (warning only), not the page's text.
- **↻ and scheduled refresh of a dashboard with data refresh only the data.** The build reads the sources, then calls `finish_build` with the same path, the new `data` and `sources` / `metrics`; the stored page stays as it is (the page file isn't read for saving and `edit_page` isn't offered). The save writes `data`, `dataVersion` +1, `dataUpdatedAt`, a version row `reason: "refresh"`, and keeps `pageUpdatedAt`, so an open viewer shows it in place. The M24 rule stays: at least one declared source must have been read. Why: the page didn't need rewriting; a data-only refresh is faster, can't break the layout, and the model still does the reading. To change the look, ✎ / edit_artifact. Dashboards without data, and every other type, refresh the whole page as before.
- **Schedule tick**: a slot counts as done once content time (`max(updatedAt, dataUpdatedAt)`) is past it, so a dashboard a task keeps up to date isn't refreshed on top.

- i18n: one server-built phrase, `run.step.artifact_data` ("Updated dashboard data" / 「更新仪表盘数据」). The run step's grey line is the paths the ops touched (`total, categories.0.count, recent`), empty for a whole replace. A data update posts no chat line (the dashboard itself changes); refresh_artifact keeps its "Refreshed <title>." line. Version labels ("Data updated by Claude", "5 updates") are the app's own strings.

## M27 voice

Voice settings apart from models, StepFun's region, optional cloud dictation. Shapes in `backend/src/contract/m27voice.ts` (plus `ModelProvider.region`, `CreateModelProviderRequest.region`, `UpdateModelProviderRequest.region` and `RemoteModel.transcription` in `m12.ts`, and `VoiceSettings.providers` / `presets` / `dictation` and `UpdateVoiceSettingsRequest.dictation` in `m13.ts`); samples in `docs/api-samples/m27voice.json`; migration `m27_voice` (additive: `ModelProvider.region` TEXT NULL, `User.dictationEngine` TEXT NOT NULL DEFAULT 'device', `User.dictationOnDevice` BOOLEAN NOT NULL DEFAULT false, `User.dictationProviderId` / `dictationModelId` TEXT NULL, then every existing StepFun row gets `region = 'cn'`). An app built before M27 keeps working: every new response field has a default it ignores, `GET /api/models` still lists the voice models, `VoiceSettings.modelId` / `voice` / `voices` / `configured` mean what they did, and calls start exactly as before (a StepFun provider from before M27 is `cn`, which is the address it already used).

**Which page shows what.** The Models page lists chat models only; the Voice page has realtime voice (provider, model, voice) and speech recognition (the composer microphone). The API isn't split: `GET /api/models` keeps returning every ModelEntry (`purpose` chat and realtime) and every provider, so older apps keep their "Voice" group, and the M27 app filters (Models: `purpose == chat`; Voice: `GET /api/voice-settings`). A Gemini or StepFun provider is one `ModelProvider` row with one key for both pages: adding it on either page makes it appear on the other. Deleting it (Models, provider page) deletes its chat and voice models as before; the Voice page has no delete of its own. A user may have several providers of a kind (say StepFun mainland and StepFun international); each is listed.

### Regions and addresses

- `ModelProvider.region` (`ProviderRegion`): `cn` (mainland China) | `intl` (international) for kinds that have regions (`REGIONS_OF`: only `stepfun`); `null` for every other kind. Rows from before M27 are `cn` (the migration), which is what they used.
- **Create** (`POST /api/providers`): `region` only for stepfun (any other kind: 400 `validation_failed` field `region`). Without it: `defaultProviderRegion(kind, User.region)`: `CN` -> `cn`, any other country -> `intl`, unknown (null; an app before M25 sends no X-Region) -> `cn`. Without `baseUrl` the provider gets the region's chat base URL and the key is checked there. A given `baseUrl` (a proxy) is kept as it is and checked as before.
- **Change** (`PATCH /api/providers/:id` `{region}`): stepfun only (else 400 `region`). A `baseUrl` that is still the old region's chat base URL moves to the new region's; one the user set by hand (a proxy) stays. The key (the stored one, or `key` in the same request) is checked against the provider's chat host after the change; a failure is 400 with the reason and nothing is saved. No re-typed key is needed: both hosts are StepFun's own fixed addresses, never an address a user typed. An explicit `baseUrl` in the same request wins over the move.
- **Wrong site:** when StepFun refuses the key (401 / 403) on create or on a region change, the server tries the other region's model list once with the same key. If that answers, the answer is 400 `validation_failed` field `region` ("this key belongs to StepFun's international site (api.stepfun.ai)", or "… mainland site (api.stepfun.com)") so the app can offer to switch; else the usual `key: the key was refused`. `POST /api/providers/:id/test` doesn't probe.
- **The fixed addresses** (`VOICE_ENDPOINTS`; the user never types one):

| kind:region | chat / model list (`baseUrl` default) | realtime (StartCallResponse.url) | cloud dictation |
|---|---|---|---|
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained` (token from `https://generativelanguage.googleapis.com/v1alpha/auth_tokens`, as M13) | `chat_audio`: `{baseUrl}/chat/completions` with an `input_audio` part |
| stepfun:cn | `https://api.stepfun.com/v1` | `wss://api.stepfun.com/v1/realtime?model=<id>` | `asr_sse`: `POST {baseUrl}/audio/asr/sse` |
| stepfun:intl | `https://api.stepfun.ai/v1` | `wss://api.stepfun.ai/v1/realtime?model=<id>` | `asr_sse`: `POST {baseUrl}/audio/asr/sse` |

  Both StepFun sites take `Authorization: Bearer <key>` on the WebSocket upgrade and the model as `?model=`; nothing else in StartCallResponse changes. The realtime URL follows `region` (null reads `cn`); chat, the model list and dictation follow `baseUrl`. Read on 2026-10-29 from the public docs: `https://platform.stepfun.com/docs/zh/api-reference/realtime/chat.md`, `https://platform.stepfun.ai/docs/en/api-reference/realtime/chat.md`, `https://platform.stepfun.ai/docs/en/quickstart/overview`, `https://platform.stepfun.ai/docs/en/api-reference/models/list.md`, `https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse.md`, `https://platform.stepfun.ai/docs/en/api-reference/audio/asr-sse.md`, `https://ai.google.dev/gemini-api/docs/openai` ("Audio understanding": `input_audio` with `format: "wav"`). No key was used.
- **Voices per region** (`REALTIME_VOICES`, first = default): gemini and stepfun:cn are M13's lists unchanged; stepfun:intl is `soft-spoken-gentleman`, `magnetic-voiced-male`, `vibrant-youth`, `lively-girl`, `livelybreezy-female`, `elegantgentle-female`, `zixinnansheng` (the international realtime endpoint refuses other names with 400). `VoiceSettings.voices.stepfun` stays the mainland list (old apps); `VoiceProvider.voices` is the provider's own list. `PUT /api/voice-settings` checks `voice` against the chosen model's provider's list (400 `voice`); a call whose stored voice isn't in that list uses the list's default (as M13 does for the other engine).
### The Voice page's data

- **Reads**: `GET /api/voice-settings` -> VoiceSettings, everything the page needs in one answer:
  - M13's `modelId`, `voice`, `voices`, `configured` (unchanged);
  - `providers` (`VoiceProvider[]`): the user's gemini / stepfun providers, oldest first: `id`, `kind`, `name`, `region`, `key` (`{set, last4}`), `status` / `error` (the last check), `voices` (its region's list) and `realtimeModels` (`[{id, modelId, label}]`, its purpose-realtime ModelEntries, oldest first). No address.
  - `presets` (`VoiceProviderPreset[]`): one per voice kind, `{kind, regions: [{region, host}], defaultRegion}`; gemini has no regions; stepfun's `defaultRegion` is `defaultProviderRegion("stepfun", User.region)`. The app shows the region's name (its own strings) with the host.
  - `dictation` (`DictationSettings`): `{engine, onDeviceOnly, providerId, modelId, cloudReady}`. `cloudReady` = the provider is the user's gemini / stepfun one, not `failed`, has a key, and `modelId` is set (whatever `engine` is). A provider deleted since reads `providerId: null`.
- **Writes**, reusing the existing routes:
  - add a provider with its key: `POST /api/providers {kind, key, region?}` (checked before saving, 400 with the reason; the page shows it under the key field);
  - replace the key or change the region: `PATCH /api/providers/:id {key?, region?}`; check again: `POST /api/providers/:id/test`;
  - the realtime model: `GET /api/providers/:id/remote-models` (rows with `realtime: true`), `POST /api/models {providerId, modelId}` (purpose realtime from the catalog, as M12) if not added yet, then `PUT /api/voice-settings {modelId}`;
  - the voice: `PUT /api/voice-settings {voice}`;
  - speech recognition: `PUT /api/voice-settings {dictation: {...}}`.
  With no key, the rows under the key are grey and can't be opened. Nothing is added automatically when a key is saved.
- **`UpdateVoiceSettingsRequest.dictation`** (only the fields that change): `engine` device | cloud; `onDeviceOnly`; `providerId` (the user's gemini / stepfun provider, else 400 field `dictation.providerId`; null clears it and the model); `modelId` (1-200 characters; needs a provider, set or stored, else 400 `dictation.modelId`; null clears it). A new `providerId` without `modelId` clears `modelId`. `modelId` isn't checked against the provider's list, because StepFun may not list its recognizers: a wrong id fails at the first transcription (502). `engine: cloud` is accepted before a provider is chosen; `cloudReady` stays false until one is.

### Speech recognition (the composer microphone)

- `device` (default): Apple's recognizer (SFSpeechRecognizer, as today, live partial results). `onDeviceOnly` sets `requiresOnDeviceRecognition`: audio never leaves the iPhone. When the iPhone can't recognize this language on the device, the mic says so; nothing is sent to Apple's servers instead.
- `cloud`: the app records 16 kHz mono 16-bit WAV (stopped by a second tap, by Send, or at 120 s), then `POST /api/transcriptions` and puts the text into the composer. No partial results while recording. `onDeviceOnly` doesn't apply. When `cloudReady` is false the mic doesn't record and says why (the Voice page sets it up); it never falls back to Apple's recognizer on its own. A failed transcription keeps the recording in memory so the user can retry; it's dropped when the composer is sent or cleared.
- Which models count as recognizers: `RemoteModel.transcription` = models.dev says audio in, text out and not realtime; or the id names one (`asr`, `transcribe`, `whisper`, `stt`). The picker lists those first and also takes a typed model id. StepFun documents `stepaudio-3-asr-max`, `stepaudio-2.5-asr` (both sites) and `stepaudio-2-asr-pro` (mainland) for `/v1/audio/asr/sse`; the legacy `step-asr` is only on the mainland's `/v1/audio/transcriptions`, which this doesn't use. Gemini: any model that takes audio (its chat models do).

### POST /api/transcriptions

- `multipart/form-data`: `file` (required) and `language` (optional, `TranscriptionLanguage`, a BCP 47 tag; only its primary subtag is used; default from `User.language`: zh-Hans -> `zh`, else `en`). Uses the saved `dictation.providerId` / `modelId` (whatever `engine` is, so the Voice page can try it). `Cache-Control: no-store`.
- The file: WAV (RIFF / WAVE, `fmt ` PCM or WAVE_FORMAT_EXTENSIBLE with a PCM subformat; other chunks are skipped), 16-bit, 1-2 channels, 8000-48000 Hz. At most `TRANSCRIPTION_MAX_BYTES` (8 MB; the body limit answers 413 before parsing) and `TRANSCRIPTION_MAX_SECONDS` (120, from the data size and byte rate), at least `TRANSCRIPTION_MIN_SECONDS` (0.3). The server sends it on as WAV; it doesn't convert.
- 200 `TranscriptionResponse {text}`: trimmed; `""` when nothing was said.
- Errors (checked in this order; nothing is stored either way):
  - 400 `validation_failed` field `file`: not multipart, no file, empty, a WAV header it can't read, or shorter than 0.3 s;
  - 415 `unsupported_type` field `file`: anything but 16-bit PCM WAV (by its bytes, not its name);
  - 413 `too_large`: over 8 MB or 120 s;
  - 400 `validation_failed` field `language`: not a tag, or one the provider doesn't take (StepFun: `STEPFUN_ASR_LANGUAGES` zh, en, ja, ko, fr, es; Gemini: any, passed as a hint);
  - 400 `not_configured`: `cloudReady` is false (no provider, gone, failed, no key or no model);
  - **502 `transcription_failed`** (`TranscriptionErrorCode`): the provider refused the key, rate-limited, timed out (`TRANSCRIPTION_TIMEOUT_MS`, 60 s), couldn't be reached, or answered without text. The message is the server's plain words (`StepFun refused the key (api.stepfun.ai).`, `Google didn't answer in time.`, `<host> answered 429.`), never the provider's body. The whole request is bounded by `TRANSCRIPTION_TIMEOUT_MS` (one AbortSignal): `chat_audio` keeps `stream()`'s usual retries before any output (429 / 5xx / network) inside it; `asr_sse` is one attempt.
- Privacy: the audio is held in memory for the one request: never written to FILES_DIR, the database, a log line, an event or a run record, and the text isn't stored. A log line has the provider kind, bytes, seconds, the outcome and the time taken. The key joins the redaction set like a chat turn's.
- Not counted in usage limits (M9): the user's own key pays the provider, and an ASR call has no token usage on the chat ladder. One request at a time is not enforced.

### The model layer

- AGENT.md and prompt L57 say models are called only through `llm/` `stream()`. Dictation calls one new function, `transcribe(target, audio, options)` in `backend/src/llm/transcribe.ts`, exported from `llm/index.ts`; nothing outside `llm/` builds a provider request.
- The request shape comes from the kind's `VOICE_ENDPOINTS[...].transcription`, not from the vendor's name:
  - `chat_audio` (gemini): `stream()` with one user message holding a new canonical `audio` block (`{type: "audio", format: "wav", data: <base64>}`) and a fixed instruction (transcribe exactly, in the spoken language and script, no comments, nothing when nothing was said; the language as a hint), thinking off, no tools. The openai adapter sends it as `{type: "input_audio", input_audio: {data, format: "wav"}}`; the anthropic adapter refuses it as an unsupported request. The text is the joined text deltas.
  - `asr_sse` (stepfun): one `POST {baseUrl}{transcriptionPath}` (`Authorization: Bearer`, `Accept: text/event-stream`, JSON `{audio: {data: <base64>, input: {transcription: {model, language, enable_itn: true}, format: {type: "wav"}}}}`), read as SSE; the text is the `transcript.text.done` event's `text` (an `error` event is a failure). It isn't a chat model, so it can't go through `stream()`: this is a deviation from L57's one interface, kept inside `llm/` with `secureFetch`'s rules (no redirects, a deadline, the key only in the auth header, errors as `LlmError` codes without the provider's body).
- prompt L58 lists two wire adapters (anthropic, openai); `asr_sse` is a third request shape, only for dictation.

### Labels and the composer (app only)

- "Name" reads 「名称」 on the provider and model forms; the onboarding illustration's sign-up form uses a new key "Full name" (「姓名」). The provider's name stays free text (1-60 characters; no change on the server).
- The mic doesn't turn orange while recording (it keeps the primary text colour on a grey disc).
- Gemini and StepFun forms (add and edit, on either page) have no Base URL row: the address follows the kind and the region; StepFun's have a Region row (mainland China / international, with the host). The server still takes `baseUrl` for them (older apps; a proxy set before M27 keeps working and is shown read-only).

- i18n: no server-built phrases. The refusals above are plain words for `validation_failed` / `transcription_failed`; the app shows its own strings by code and field.

**Spec deviations (prompt.txt unchanged):** L92 and L96 say dictation uses SFSpeechRecognizer; M27 keeps it as the default and adds the optional cloud recognizer and the on-device switch (the user's decision of 2026-10-29). L57 (one `stream()` interface) and L58 (two adapters): `transcribe()` and its `asr_sse` shape above.

## M27 computer file tools

Model tools on Claude's computer; no HTTP contract or schema migration. Paths are relative to /workspace (a /workspace prefix is normalized); traversal and resolved symlink escapes are refused.

- `computer_files_read(path, offset?, limit?)`: optional positive, 1-based line offset and line count; omitted range reads from the beginning as before. Downloads at most 10 MiB and refuses invalid UTF-8. Returns `{path, text, fromLine, toLine, totalLines, truncated, bytes}` with at most 60,000 characters. A final newline ends its line, not an extra empty line; empty files have zero lines. Past EOF returns empty text with the requested fromLine and toLine = totalLines. A capped last line can be partial. Older computers without /files/download fall back to the 64,000-byte beginning read, refuse any offset, and return totalLines null if that read was truncated.
- `computer_files_edit(path, old_string, new_string, replace_all?)`: edits an existing UTF-8 file by exact replacement (including whitespace). old_string must be nonempty and unique unless replace_all is true. Reuses edit_page's not-found / occurrence-count / whitespace hints. Both the original and edited file must fit 1,000,000 UTF-8 bytes; missing, invalid UTF-8 and oversized files are refused without writing. Returns `{path, bytes, replacements, sharedFileId}`. Like write, updates the same shared file card for a normalized path in a turn (including send_file); Make builds post no file card. Paths under artifacts/ have the same write rules and artifact-file linking, not a new protection rule.
- `computer_files_search(query, regex?, path?, glob?, ignore_case?)`: literal by default, extended regex with regex true; folder defaults to the root, glob filters file names (e.g. *.csv). A fixed shell-quoted grep -rIn command checks the physical folder stays in /workspace, skips binary files, .git and node_modules, and does not follow nested symlinks. Runs through /exec with a 20-second deadline, not through the computer_exec tool or its Ask policy. Returns `{path, matches, truncated, note?}`; each match is `path:line: text` relative to /workspace. Keeps the first 200 matches, caps each displayed line at 300 characters (conservatively 300 bytes for multibyte text to stay below /exec's output cap), and says when capped. Missing/disabled exec or a timeout is a clear error; no file card.
- Policy: read and search are Read / Always; edit is Write / Always like write. The user's per-tool Ask override still uses ToolPolicy + Approval, including approved headless calls and the existing no-one-here build refusal. Search/read results and errors are untrusted content; search is read-only for harness claims and background retry checks. Audit stores the path/folder only, never edit text or search query; run input likewise omits those contents. computer_exec remains Ask and is only for running programs, not listing, reading, writing, editing or searching files.
- Phrases: `run.step.files_edit` = "Edited a file" / 「编辑文件」; `run.step.files_search` = "Searched files" / 「搜索文件」 (server catalogs and iOS phrase catalog). Tool picker names/descriptions for Edit files and Search files are app strings.

## M27 pre-VPS security hardening

- `POST /api/session`: 16 KiB cap before parsing/limiting; 413 `request_too_large` (`ApiError`). IP and (IP, normalized username) failure buckets lock with exponential backoff (up to 900 s, 15 min window); username-only failures slow verification by up to 30 s, not a cross-IP lockout. Success clears that pair and username slowdown, not the IP bucket. 429 carries `Retry-After`. Only exact trusted proxy service addresses may supply `X-Forwarded-For`; Docker DNS is cached 30 s, fails closed. Sign-in success/failure/lock logs contain username and resolved IP, never passwords/tokens; sessions store that IP and capped User-Agent.
- Password creation/change through the administrative CLI: at least 12 characters, common-password blocklist; existing credentials continue to sign in. No registration/password HTTP endpoint is added.
- All other non-upload `/api/*` request bodies: 6 MiB; existing uploads and 30 MiB outer transport/edge caps are described in Conventions. The edge/transport can reject without a JSON body.
- `POST /api/providers` and provider PATCH validate public DNS before saving; model/list/dictation requests revalidate immediately before sending and pin the connection with original Host/SNI and certificate verification. Localhost, exact `LLM_ALLOW_INSECURE_HOSTS`, and exact `LLM_ALLOW_PRIVATE_HOSTS` bypass address blocking (the latter permits HTTPS only). A disallowed save returns 400 `validation_failed`, field `baseUrl`; a runtime failure uses existing model/verification errors. Fake-IP policy is shared with web_fetch/connectors: `auto` by default, `1` force allow, `0` deny; other private/embedding ranges stay blocked.
- `POST /api/devices` returns 404 `not_found` for a token owned by another account and does not change that registration. Same-owner re-registration remains idempotent. `DELETE /api/devices/:id` by the owner (including iOS sign-out) frees it for registration by another account. Offline sign-out is best-effort; an undeleted old registration must be removed by the previous owner.
- Composio logos use guarded, manually validated HTTPS redirects (at most three), a 1 MiB streaming cap and a shared 5 s deadline. Refused/unreachable/non-image logos retain the existing not-found behavior.
- Computer egress HTTP/CONNECT destination ports are limited to 80/443; SSH git, SMTP and alternate-port registries are blocked. No changes to Chromium sandboxing, build approvals, session lifetime or open-stream revocation (H2/M4 deferred to M28).

## M28 sessions

Login sessions (security review M4): a fixed 90-day lifetime, only `sha256(token)` kept on the server, the signed-in devices list, signing one or all other devices out, and their open streams closed. Shapes and constants in `backend/src/contract/m28.ts`; samples in `docs/api-samples/m28.json`; migration `20270209090000_m28_sessions` (additive: `Session.tokenHash` unique, `lastUsedAt`, `lastIp`, `deviceName`; `DeviceToken.sessionId` indexed, no foreign key). Sign-in and its `SignInResponse` don't change: the app still gets a 32-character token, keeps it in the Keychain and sends `Authorization: Bearer <token>`.

**What the server keeps.** `Session.tokenHash` = sha256 of the token's exact UTF-8 bytes as 64 lowercase hex (`sessionTokenHash`). Better Auth 1.7.12 has no option to store only a hash (it creates, finds and deletes sessions by the raw `token` column), so `signInUsername` still checks the password and creates the session, and its `session.create.before` database hook rewrites the row before the insert: its own `id`, `token` = `hashed <id>` (`hashedTokenPlaceholder`: the space means no bearer header can carry it, also on a server rolled back to before M28) and `tokenHash` (a Better Auth `session.additionalFields` entry). The hook hands the raw token to the sign-in route in memory only (per request), and the route answers with it; the raw token is never written to the database, not even for a moment. The route then sets `ipAddress`, `userAgent`, `deviceName`, `lastUsedAt`, `lastIp` on the new row by id. A session created any other way (none is mounted) fails closed. Every authorized request looks the session up by `tokenHash` (`bearerToken` reads the header, the same `Bearer \S+` rule as before); Better Auth's `getSession` is no longer used. The raw token is never logged, stored elsewhere or returned again; `SessionInfo` carries neither it nor its hash.

**Lifetime.** `expiresAt` = `createdAt` + 90 days (`SESSION_MAX_AGE_MS`), set at sign-in and never extended: no rolling refresh, no idle timeout. From `expiresAt` on, every request with that token is 401 `unauthorized` and the app goes back to sign-in (as for any 401). Expired rows are deleted by the hourly housekeeping. Signing in again starts a new 90 days.

**Sessions from before M28.** At startup, before it serves a request, the server converts every row without `tokenHash`: hashes its raw token into `tokenHash`, writes the placeholder over `token`, sets `expiresAt` to the earlier of its stored value and `createdAt` + 90 days, and deletes rows already past it. Signed-in phones stay signed in (their token now matches by hash). One transaction with SQLite's `secure_delete` on, then a WAL checkpoint (TRUNCATE), so the raw values don't linger in free pages or the WAL; only counts are logged. Idempotent; the hourly housekeeping repeats it as a safety net (a row restored from an old backup, say). Rows before M28 have `lastUsedAt`, `lastIp` and `deviceName` null until that phone's next request. **Rollback** to a server before M28: it looks sessions up by the raw token, which is gone, so every phone signs in once again (the placeholder can't be used as a token). A database backup from before M28 still holds raw tokens, valid until their sessions end.

**Activity.** On an authorized request the server writes `lastUsedAt` = now and `lastIp` = the client IP (the same resolution as sign-in's) when the stored `lastUsedAt` is null or at least 5 minutes old (`SESSION_TOUCH_INTERVAL_MS`), or the device name changed. `ipAddress` stays the sign-in's (`signInIp`).

**Device name.** The app sends `X-Device-Name` (`DEVICE_NAME_HEADER`) on every request, sign-in included: the model's name from the app's own table (`iPhone 15 Pro`, `iPad Air`; else `iPhone` / `iPad`), never the user's own device name (that needs an entitlement and is personal). `DeviceName`: trimmed, 1–64 characters, printable ASCII; a missing or invalid value is ignored and the stored one kept (like `X-Timezone`). The push token table can't name a device (it has no name column), so sessions before M28 show without a name until their next request.

**GET /api/sessions** → `SessionList`: every live session (`expiresAt` in the future) of this user, the current one first (`current: true`, exactly one), then by `lastUsedAt` newest first (null last), then `createdAt` newest first. No paging or cap. `userAgent` "" reads as null. `push` = an APNs `DeviceToken` row linked to that session exists.

**DELETE /api/sessions/:id** → 204: that device is signed out at once (its next request is 401, its open streams close, below). The current session is 400 `validation_failed`, field `id` (sign out is `DELETE /api/session`); an unknown id, an expired one or another user's is 404 `not_found` (the app treats it as already gone and drops the row).

**POST /api/sessions/revoke-others** → `RevokeOtherSessionsResponse` `{ revoked }`: deletes every session of this user except the current one in one transaction; `revoked: 0` is fine. One call rather than one DELETE per row, so it is atomic, can't miss a session the list didn't show yet (signed in meanwhile), and is a single round trip.

**Push.** `POST /api/devices` links the token to the calling session (`DeviceToken.sessionId`, also on re-registration; a token moves to the session that registered it last). Deleting sessions (one, the others, `DELETE /api/session`, expiry) deletes the `DeviceToken` rows linked to them; DELETE one and revoke-others also delete this user's rows with `sessionId` null (registered before M28, owner unknown), and the current phone re-registers on its next launch. `user:password` revokes every session and deletes the user's device tokens. APNs sends only to rows whose session is live, or whose `sessionId` is null. ntfy and bark push to a topic, not to a device, so signing a device out doesn't stop them.

**Open streams.** Each open stream remembers its session: `GET /api/events`, the answer streams of `POST /api/channels/:id/messages` and `POST /api/tasks/:id/messages`, and `WS /api/computer/stream`. Revoking a session through the API closes its streams at once; every 60 s (`SESSION_STREAM_CHECK_MS`) the server also closes streams whose session is gone or expired (the CLI, expiry). SSE: the stream just ends (no new event type); the app's reconnect gets 401 and it signs out. A run whose answer stream ended carries on and is stored as usual. WebSocket: closed with code 4001 (`SESSION_ENDED_CLOSE_CODE`), reason `session ended`; the app doesn't retry on 4001 but makes one authorized request, whose 401 signs it out. An app before M28 retries the socket; the upgrade is 401.

**Errors.** Every session failure (no or malformed header, unknown token, expired, revoked) stays 401 `unauthorized` "Sign in again.": no new code, because the app maps unknown codes to a server error and would not sign out. The new routes use `validation_failed` and `not_found` only.

**Older app:** sends no `X-Device-Name` (its rows show without a name), has no devices page, stays signed in through the conversion, is signed out by a revoke at its next request. **i18n:** no server-built phrases (the page's text is the app's own strings).

**Spec deviations (prompt.txt unchanged):** L56 "sessions are long-lived, refresh on use and survive restarts": M28 sessions survive restarts but don't refresh; they end 90 days after sign-in. L128's profile sheet list gets a "Signed-in devices" row above Sign out (the app's devices page, M28). L56's "`user:password` … revokes every session" holds.

## M27 browser

The live browser (landscape 1280 × 800 by default since C2; portrait is an option), with the app's own tab strip and address bar in the full-screen "Claude's computer" view. Shapes in `backend/src/contract/m27browser.ts` (plus `browser_bar` in `ComputerServerMessage`, `contract/computer.ts`); samples in `docs/api-samples/m27browser.json`; the computer side is `computer/patches/0006-bot-tabs-portrait.patch`. No migration, no new setting.

The user's decisions (2026-10-29): headless stays the default; the page becomes portrait and narrow, close to a phone's, with the desktop Chrome user agent; the chat's live card and the computer page's preview card stay landscape 16:10 and show the portrait frame fitted to the width, top-aligned, cropped at the bottom (the M20b rule); the full-screen view draws its own bar like desktop Chrome (tabs with icon, title and ✕, a + at the end; ← → ↻ and an address field under them), always visible, read-only while Claude works; after Take over the user can switch, close and open tabs, type an address, go back / forward / reload; closing the last tab opens the start page; after the hand back Claude carries on in the tab the user picked.

C2, the owner's decisions (2026-10-30): **always landscape**, because Claude's screenshots must be wide, so `COMPUTER_BROWSER_SCREEN` defaults to `landscape` again; portrait stays in patch 0006 as an option nobody sets. The app fits the landscape frame to the width with its own bar above, and a full-screen button turns that view to landscape (the iOS side, W6). Search and the start page follow the user's region. **No site icons in M27**: the tabs show titles only.

**The page.** Landscape (the default): 1280 × 800 CSS px at scale 1, so the frames are 1280 × 800 JPEGs and `frame_meta` says 1280 × 800, as before M27. `compose.yml` and `setup.sh` default `COMPUTER_BROWSER_SCREEN` to `landscape`; unset in the container it is landscape too. Checked on the C2 test images with the variable unset: frames, `frame_meta` and `/screenshot` 1280 × 800; Cloudflare npmjs.com 2 of 2 and nowsecure.nl 2 of 2 with the real title at +5 s, on an earlier C2 build with the same Chromium and flags (contract C's, which measured landscape 8 of 8 and 8 of 8 below). Window mode follows the same setting (1280 × 800 by default, 860 × 1600 with `portrait`). Claude's `computer_screenshot` is the 1280 × 800 page again.

**Portrait (an option, contract C's page):** `COMPUTER_BROWSER_SCREEN=portrait` gives a 430 × 660 CSS px page at a device scale factor of 2: the frames are 860 × 1320 JPEGs and `frame_meta` says 430 × 660 (CSS px, as before; the app lays out by its aspect ratio). Why: 430 is a large iPhone's width, so responsive sites lay out as on the phone and text needs no zoom; 660 is about what the full-screen view has under the app's own bars on a 6.1–6.9" iPhone, so the whole page shows at the full width (a taller page would be scaled down or scrolled inside the view). Scale 2, not 3, keeps the frames' size near today's 1280 × 800 ones. The user agent stays desktop Chrome and `window.screen` reads a desktop's 1920 × 1080 (a headless window is never narrower than 500 DIP, so the default screen, the viewport, gave a page `outerWidth` 500 on a `screen.width` of 430, which no real browser shows). `COMPUTER_BROWSER_SCREEN` applies headless as well as headed. Claude's `computer_screenshot` is the page in CSS px, so with portrait the model sees a 430 × 660 page. Cloudflare, measured in contract C (a fresh computer and profile for each round, rounds alternating, title read +5 to +25 s): headless portrait npmjs.com 8 of 8 and nowsecure.nl 8 of 8, headless landscape 8 of 8 and 8 of 8 (M20b's headless baseline: 8 of 8); every load had its real title at +5 s and none showed a challenge. The computer's memory after nowsecure.nl: about 352 MiB portrait against 324 MiB landscape (median; the scale 2 page).

| Method | Path | Request | Response |
|---|---|---|---|
| GET | /api/computer/tabs | – | BrowserBar (at any time, read-only; starts nothing; `supported: false` from a computer before patch 0006) |
| POST | /api/computer/tabs | NewTabRequest | BrowserBar (a new tab in front; no `address` = the start page) |
| POST | /api/computer/tabs/:tabId/activate | – | BrowserBar |
| POST | /api/computer/tabs/:tabId/close | – | BrowserBar (the last tab: the start page opens in its place) |
| POST | /api/computer/navigate | NavigateRequest `{ address }` or `{ action: back \| forward \| reload }` | BrowserBar (the active tab) |

- **Only after Take over.** Every POST answers 409 `take_over_first` unless this user holds the browser (Claude drives, or no one took over). Other errors: 404 `not_found` (the tab has closed, or an id that can't be one), 501 `tabs_unsupported` (the computer predates patch 0006), 400 `validation_failed` field `address` (also for an address with a user name or password, `https://bank.com@evil.com/`, and for one, or a search, whose URL would pass the computer's 2000 characters: "address: too long" / "address: too long to search for"), 409 `conflict` for a new tab when 20 are open (Claude's own tabs and new tabs still opening count; close one first), 429 `rate_limited` past 30 actions in 10 s (reading the bar is never limited), 502 `internal` (the computer couldn't be reached), 503 `not_configured` (no computer, or not its owner). Each action counts as the user's input (the 10 minute auto hand back stays away), is in flight for Sleep (409 `computer_busy`), and goes to the AuditLog like the other computer actions: `browser_new_tab`, `browser_switch_tab`, `browser_close_tab`, `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, actor `user`, target the page's domain, outcome ok / error. What was typed is never logged or stored.
- **Timing.** An action answers once the new page has started loading (Playwright's `commit`; at most 15 s on the computer, 25 s on the backend), with the tabs as they are then; measured on the test image: new tab 1.9 s, navigate 1.7 s. The loaded title and the history come after it on the stream.
- **Tabs.** `id` is the browser's own target id, stable for the tab's life (an id that isn't `^[A-Za-z0-9_-]{1,200}$` is dropped). `url` "" = a blank tab; on Chromium's error page it is the address that failed. `title` "" = none (or one that only repeats the address): the strip shows the domain, or "New tab". Both are the page's to choose, so the backend cleans them on every path (the routes, the actions' answers, the stream): `url` is the parsed http(s) form (ASCII, punycode, percent-encoded) with any user name and password removed, a `blob:` page reads as the http(s) origin that made it (`https://site.example/`), and "" for another scheme or junk; when `url` is "" (a blank tab, `about:`, `data:` ...) `title` is "" too, so a page can't put its own title on what reads as a new tab. `title` is well-formed (a lone surrogate becomes U+FFFD, a cut never splits a pair), one line, at most 300 UTF-16 units, without controls or default-ignorable characters (direction marks, overrides and isolates, zero-width space, soft hyphen, Hangul fillers, tag characters, BOM ...); ZWJ, ZWNJ, variation selectors, Mongolian variation selectors and the tags inside a flag stay. The app cleans and cuts again for display (W6). At most 50 tabs are listed, the active one always among them. Activating brings the tab to the front and Claude follows it from then on (patch 0004's rule, now also headless): after the hand back Claude carries on there. Closing the active tab moves to its right-hand neighbour, else the left one, as a browser does; closing another tab leaves the active one. Closing the last tab opens the start page first, so there is always a page. A new tab without an address opens the start page (`COMPUTER_START_URL`, else by region, below) and the app focuses the address field.
- **The address field.** Resolved on the server, as a desktop browser's bar reads it: an `http(s)://` address as it is; a bare host (a dotted name whose last label has a letter, an IPv4 address, `localhost` or `[IPv6]`, with an optional port and path, e.g. `example.com`, `localhost:3000/x`) as `https://`; any other scheme without spaces (`file:`, `javascript:`, `chrome:`, `data:`, `mailto:` …) is refused with 400 `validation_failed` (the browser opens web pages only); anything else (words, `3.14`, `github`, `note: buy milk`) is a search with the user's engine (below). 1–2000 characters after trimming; the computer accepts only http(s) itself too. The egress proxy's rules apply as to Claude's own browsing.
- **Search and start page by region (C2).** The engine follows the user's region (`User.region`, kept from the app's `X-Region`, M25; read at each action, so a phone that moved counts at once): mainland China (`CN`) or unknown (no region yet; an app before M25 sends none) → Bing (start page `https://www.bing.com/`, search `https://www.bing.com/search?q=`), because Bing answers there and Google doesn't; any other region → Google (`https://www.google.com/`, `https://www.google.com/search?q=`). Hong Kong, Macau and Taiwan have their own codes, so they get Google. The start page is what a new tab without an address, the tab that replaces the last one closed and a woken blank browser open (the last uses the computer's owner's region). `COMPUTER_START_URL` still sets one start page for every region; the search still follows the region then. Neither is a setting in the app. Shapes don't change.
- **The stream.** `WS /api/computer/stream` adds `{ type: "browser_bar", bar: BrowserBar }`, sent when the bar changed (the first soon after the screen is up). The computer checks once a second (the same loop that makes the screen follow Claude's tab) and at once after each tab or navigate action, and sends only changes; the backend passes on only changes, so a page Claude opens shows in the bar within about a second. The app reads `GET /api/computer/tabs` when the full-screen view opens (so the bar shows before the stream is up) and then the stream; it never polls. An app from before M27 drops the message (it decodes text frames with `try?`).
- **`browserBarInFrame`** is true in window mode (`COMPUTER_BROWSER_MODE=headed`): the frames are Chrome's whole window with its own tab strip and address bar, so the app draws no bar of its own.
- **Older computer** (patches 0001–0005): the tab routes answer 404, so `GET /api/computer/tabs` is `supported: false` and the POSTs 501 `tabs_unsupported`; the app's bar then shows only the host from `ComputerState.url` (or `domain`), read-only. **Older app**: unchanged; with the landscape default its frames are the 1280 × 800 ones it had before M27.
- **No site icons in M27** (the owner's decision, 2026-10-30). A tab shows its title (or the domain, or "New tab") and its ✕, with no icon and no placeholder glyph. The phone loading a site's icon would tell the site its IP address and fails where the site is blocked (mainland China); fetching icons for the phone needs an SSRF-safe path through the computer's egress proxy, a type and size check and a cache, which was drafted in C2 and set aside. `BrowserTab` has no icon field; one can be added later without breaking anything (the app decodes tolerantly).
- Tab and navigate actions are the user's, not Claude's: they are not run steps. Claude sees the page in its fresh snapshot after the hand back.
- Patch 0006 also takes OpenBot 0.2.0's keyboard fix (`computer/patches/0006`, `src/screencast.ts`): the live screen's key events no longer carry `nativeVirtualKeyCode`, which macOS Chrome read as the Mac's own key numbers (ArrowLeft as L, Home as Return) and which let unhandled keys reach the browser's own shortcuts. Typed keys now reach the page as themselves.
- Spec deviations (`prompt.txt` unchanged): L143's full-screen view is "mascot and status pill at the top, the live screen fitted to the width … and a black full-width capsule \"Take over\" at the bottom"; M27 adds the browser bar between the top and the live screen, and the user's own tab and address actions after Take over. "Rotates to landscape": turning the phone does, and C2 adds a full-screen button that turns the view to landscape without turning the phone (the bar is kept, scaled with the page). The tabs have no site icon (above).
- i18n: no server-built phrases ("New tab", the bar's labels and the refusals are the app's own strings).

## M28 computer URL privacy (R5 + P2-7)

- `ComputerState.url` is the parsed http(s) **origin + path** only (or null for a blank, non-web or invalid page). User name, password, query and fragment are removed before the state reaches `GET /api/computer`, control responses, stream `state` messages, or persisted/replayed `computer` events. `domain` remains the hostname. For example, `https://user:pass@a.example/cb?code=SECRET#x` becomes `https://a.example/cb`. / `ComputerState.url` 只保留 origin 和路径；账号、密码、查询参数和片段不会进入电脑状态、事件表和回放。
- Claude's browser tool results and in-memory page checks keep the full parsed http(s) address, including query and fragment, **without credentials**. The example above is `https://a.example/cb?code=SECRET#x` for Claude. The live `BrowserBar` (`GET /api/computer/tabs`, action responses and `browser_bar`) also keeps its full credential-free address; it is not stored in Event. / Claude 与实时地址栏保留去掉账号密码的完整网址，包含查询参数和片段。
- The iOS computer cards show `domain`. W6 fills the address editor from the live active tab, so editing keeps the full URL; the older-computer fallback remains host-only. Computer audit targets remain domain-only; backend computer logs omit raw page/error data. Patch 0006 logs a fixed navigation reason or a network error code instead of Playwright's first error line, which can contain a private URL. Applying that log fix requires rebuilding the computer image. / App 卡片仍显示域名，点开地址栏仍能编辑完整网址；电脑导航失败日志只记固定原因或网络错误码。
- This changes new state/events only; existing Event rows are not rewritten. No migration or wire shape change. / 只影响新状态和新事件，不修改已有事件，无迁移、无接口结构变化。

M28 P2-8: `COMPUTER_START_URL` is optional; when set it must be an http(s) URL without a user name or password and at most 2000 characters. Startup rejects invalid values with a `ConfigError` naming the variable and the failed rule, without echoing the address. Blank/unset values keep the regional start page. / 起始页变量仅接受不带账号密码、最长 2000 字符的 http(s) 网址；不符合时启动报错并指出变量和原因，空值仍按地区选默认起始页。

M28 dependencies: the backend pins both installed deepmerge-ts dependency paths to 8.0.2 through a `^8` override; Prisma/client remain 6.19.3. No HTTP or stream shape changes. A changed lockfile requires a full backend image build rather than an overlay. / deepmerge-ts 的两条依赖路径统一使用 8.0.2，接口结构不变；部署时必须完整重建后端镜像。

## M29 notify

When a run stops (it finished, it waits on the user, it failed) and the user isn't looking, one push: at most one per run, the most specific. Shape in `backend/src/contract/events.ts`; sample in `docs/api-samples/events.json`. No migration. An open app (a live `GET /api/events` stream) still gets no remote push, only the `notification` event, as before.

- **`notification` event `passive`** (boolean, default false; absent on events stored before M29): the notification follows quiet hours and the user is inside them now. It is the same value the remote push gets (APNs `interruption-level: passive`, ntfy `Priority: 2`, Bark `level: passive`), so the app's local notification from the event plays no sound either.
- **`collapseId`** gains `artifact-<id>` (a Make build's ready / failed push; route `duet://artifacts/<id>`).
- **APNs badge**: every APNs alert push carries `aps.badge` = the `GET /api/needs-you` `count` when it is sent (Waiting on you, the same number as the app's badge). The silent withdraw push carries none; ntfy and Bark carry none.
- **New pushes** (route `duet://channels/<channelId>?message=<messageId>`, collapse id `message-<messageId>`, unless noted):
  - A chat turn's reply, also the turn that carries on after an approval, form or quick reply: `notify.reply`, on the run's newest assistant message. Rings in quiet hours.
  - A check-in, scan or routine run that posted something: `notify.message`. Follows quiet hours. A quiet check-in (nothing posted) pushes nothing.
  - A form, connection request or sign-in card, when it is posted (the run may wait on it): `notify.form`, `notify.connect` {name}, `notify.sign_in` {name} (the site). A run that posted one of these (or an approval, spend request or alert card, pushed as before) gets no push when it ends.
  - A run's final failure (its `model_error` card; a background run that will be retried posts no card and no push): `notify.failed` on the card. A routine's: `notify.routine_failed` {title}, or `notify.routine_paused` {title} (route `duet://tasks/<id>`) when this failure paused it (`ROUTINE_FAIL_LIMIT` in a row).
  - A task that failed (`needs_input` with `failure`): `notify.task_failed` {title} instead of `notify.task_needs_input`, the 2 h follow-up too.
  - A task paused at the usage limit (latest update `task.paused_usage_limit`): `notify.usage_limit`. Rings in quiet hours.
  - Make: `notify.artifact_ready` {title} for a build, edit or refresh the user or a turn asked for; `notify.artifact_failed` {title} for those and for a scheduled refresh. A scheduled refresh that saved, a task's build (its task reports it) and a build that was stopped or interrupted push nothing. Rings; a scheduled refresh's, and one a check-in / scan / routine asked for, follow quiet hours.
- Quiet hours: chat turns (replies, their cards, their failures), Make builds the user asked for, the usage limit, approvals and reminders ring. Check-in, scan, routine and brief runs, task pushes and scheduled refresh failures follow them.
- **Human check**: one push (`duet://computer`, collapse id `message-<alert card id>`); its `open_browser` alert card no longer pushes a second time.
- Unchanged: approvals, reminders, the brief (its first line; its run's end pushes nothing more), task ready / needs input, a task's result, alert cards, the 2 h follow-ups.
- Never pushed: messages in a task's own session (`taskId` set; the task's status pushes), a turn a voice call is still on, a run that ended cancelled (Stop, a delete, a shutdown), a Make build run's own end, streaming updates.
- i18n (`notify.*`, en / zh-Hans; the String Catalog has the same text): `reply`, `message`, `form`, `connect` {name}, `sign_in` {name}, `failed`, `task_failed` {title}, `routine_failed` {title}, `routine_paused` {title}, `artifact_ready` {title}, `artifact_failed` {title}, `usage_limit`. Params are `{type: "text", value}`.
