// English locale.
export const en = {
	ribbon: {
		toggleRecording: "Start/Stop on-demand meeting",
		openAgenda: "Open meeting agenda",
	},
	commands: {
		startRecording: "Start unplanned meeting",
		stopRecording: "Stop recording",
		authenticateCalendar: "Authenticate calendar",
		toggleCalendarAutoRecording: "Toggle calendar auto-recording",
		openAgenda: "Open meeting agenda",
		enrichNote: "Enrich meeting note (AI)",
		toggleAiNotes: "Toggle AI notes visibility",
		cleanupRecordings: "Clean up old recordings",
		createDashboard: "Create/update meetings dashboard",
	},
	adhoc: {
		defaultTitle: "Meeting",
		started: "Recording unplanned meeting — rename the note title if you like",
		suggestingTitle: "Suggesting a title…",
		titleModal: {
			heading: "Rename this meeting?",
			desc: "Suggested title based on the discussion. Edit it or keep the current name.",
			rename: "Rename",
			keep: "Keep current",
			renamed: (name: string) => `Renamed to “${name}”`,
			failed: "Couldn't suggest a title",
		},
	},
	detect: {
		detected: (app: string) => `${app} meeting detected`,
		recordPrompt: "Create note & record",
		endedStopping: (app: string) =>
			`${app} meeting ended — stopping recording`,
	},
	notices: {
		autoRecordEnabled: "Calendar auto-recording enabled",
		autoRecordDisabled: "Calendar auto-recording disabled",
		recordingError: (msg: string) => `Recording error: ${msg}`,
		screenPermission:
			"Recording failed: Screen Recording isn't authorized. Open System Settings → Privacy & Security → Screen Recording, enable Obsidian, then fully quit and reopen Obsidian. (macOS requires this for capturing system audio.)",
		alreadyRecording: "Already recording",
		macOnly: "System recording is only supported on macOS",
		downloadingHelper: "Downloading recorder helper…",
		recordingStarted: "Recording started",
		notRecording: "Not recording",
		stoppingRecording: "Stopping recording...",
		calendarError: (msg: string) => `Calendar error: ${msg}`,
		calendarReconnect: "Google Calendar disconnected — reconnect",
		calendarReconnectAction: "Reconnect",
		recordingSaved: "Recording saved",
		unknownError: "Unknown error",
		transcriptAdded: (note: string) => `Transcript added to ${note}`,
		enriching: "Enriching meeting note…",
		enrichDone: (note: string) => `Enriched ${note}`,
		enrichError: (msg: string) => `Enrichment failed: ${msg}`,
		enrichNotConfigured:
			"Set the AI endpoint (base URL + API key) and an enrichment model in settings first.",
		enrichDisabled: "AI enrichment is disabled in settings.",
		enrichInProgress: "This note is already being enriched…",
		nothingToEnrich: "No notes or transcript to enrich in this note.",
		notAMeetingNote: "Open a meeting note to enrich it.",
		aiNotesHidden: "AI notes hidden",
		aiNotesShown: "AI notes shown",
		retentionDisabled:
			"Recording retention is off. Set a positive number of days in settings.",
		retentionCleaned: (n: number) =>
			`Trashed ${n} old recording${n === 1 ? "" : "s"}`,
		retentionNothing: "No recordings past the retention window.",
		dashboardCreated: "Meetings dashboard updated",
		transcribeError: (msg: string) => `Transcription failed: ${msg}`,
		transcribeEmpty: "Transcription produced no text.",
		transcribePartial:
			"Transcription only partially succeeded — not inserted. Try again.",
		transcribeInProgress: "This recording is already being transcribed…",
		transcribeNoNote: (audio: string) =>
			`Transcribed "${audio}" but found no meeting note to add it to.`,
		transcribeNoEndpoint:
			"Set the AI endpoint (base URL + API key) in settings before transcribing.",
	},
	statusBar: {
		recording: (hms: string) => `Recording ${hms}`,
		enriching: "Enriching notes…",
		enriched: "Notes enriched",
		enrichFailed: "Enrichment failed",
		transcribing: "Transcribing…",
		transcriptAdded: "Transcript added",
		transcribeFailed: "Transcription failed",
		creatingNote: "Creating note…",
	},
	event: {
		started: (title: string) => `"${title}" has started`,
		ended: (title: string) => `"${title}" has ended`,
		startRecordingAction: "Start recording",
		createNoteAndRecord: "Create note and start recording",
		stopRecordingAction: "Stop recording",
	},
	agenda: {
		title: "Meetings",
		notConnected: "Not connected",
		loading: "Loading…",
		lastRefreshed: (rel: string) => `Updated ${rel}`,
		connectPrompt: "Connect your Google Calendar to see meetings here.",
		connectCta: "Connect Google Calendar",
		nothingScheduled: "Nothing scheduled.",
		noMeetings: "No meetings",
		nothingElse: "Nothing else scheduled",
		earlierToday: "Earlier today",
		todayLabel: "Today",
		tomorrowLabel: "Tomorrow",
		yesterdayLabel: "Yesterday",
		daysWithoutEvents: (n: number) =>
			`${n} ${n === 1 ? "day" : "days"} without events`,
		now: "Now",
		recording: "Recording",
		startsIn: (min: number) => `Starts in ${min} min`,
		allDay: "All-day",
		attendeesCount: (n: number) => `${n} attendees`,
		refresh: "Refresh calendar",
		openSettings: "Open plugin settings",
		daysShown: "Days shown",
		previousDay: "Previous day",
		nextDay: "Next day",
		previousMonth: "Previous month",
		nextMonth: "Next month",
		actions: {
			record: "Create note and record",
			stop: "Stop recording",
			openNote: "Open note",
			createNote: "Create note",
			openLink: "Open meeting link",
			copyLink: "Copy meeting link",
			openRecording: "Open recording",
			transcribe: "Transcribe recording",
			enrich: "Enrich with AI",
			skipToday: "Hide for today",
		},
		notices: {
			linkCopied: "Meeting link copied",
			noRecording: "No recording for this meeting yet",
		},
		menuTitle: "Meeting Copilot",
	},
	dashboard: {
		attention: {
			allClear: "All meetings are complete. 🎉",
			count: (n: number) =>
				`${n} meeting${n === 1 ? "" : "s"} need attention`,
			refresh: "Refresh",
			colMeeting: "Meeting",
			colDate: "Date",
			colStatus: "Status",
			colMissing: "Missing",
			colActions: "Actions",
			missing: {
				date: "date",
				recording: "recording",
				transcript: "transcript",
				summary: "summary",
			},
		},
	},
	settings: {
		recordingFolder: {
			name: "Recording folder",
			desc: "Folder in your vault to save recordings.",
			placeholder: "Recordings",
		},
		fileNameTemplate: {
			name: "File name template",
			desc: "File name format. Tokens `YYYY MM DD HH mm ss` are replaced with the date and time.",
		},
		oneOffFolderTemplate: {
			name: "One-off meetings folder",
			desc: "Folder template for a one-off meeting's note and recording. Tokens: {{year}}, {{month}}, {{title}}, {{date}}.",
		},
		seriesFolderTemplate: {
			name: "New series folder",
			desc: "Folder template used the first time a recurring meeting is seen. Later occurrences follow wherever that folder ends up. Tokens: {{year}}, {{month}}, {{series}}, {{title}}, {{date}}.",
		},
		oneOnOneSeparately: {
			name: "Handle 1:1s separately",
			desc: "Give each 1:1 (a meeting with exactly one other attendee) its own folder under 'One-on-one folder' instead of the series/one-off rules above.",
		},
		oneOnOneFolder: {
			name: "One-on-one folder",
			desc: "Parent folder for per-person 1:1 subfolders, used when 'Handle 1:1s separately' is on.",
		},
		adhocFolder: {
			name: "Ad-hoc meetings folder",
			desc: "Folder for notes from unplanned (ad-hoc or detected) meetings.",
		},
		noteTitlePattern: {
			name: "Note title pattern",
			desc: "Filename pattern for meeting notes. Placeholders: {{title}}, {{date}}, {{start:FMT}}, {{end:FMT}}.",
		},
		noteTemplate: {
			name: "Note template",
			desc: "Body of new meeting notes. Placeholders: {{title}}, {{date}}, {{start:FMT}}, {{end:FMT}}, {{duration}}, {{location}}, {{meeting_url}}, {{organizer}}, {{attendees}}, {{attendees_list}}, {{attendees_wikilinks}}, {{event_link}}. Frontmatter (attendees, status, recording, …) is managed automatically.",
		},
		insertTranscript: {
			name: "Insert transcript into meeting note",
			desc: "When transcription finishes, write the transcript into the matching meeting note's collapsible transcript section and mark it transcribed.",
		},
		autoTranscribe: {
			name: "Auto-transcribe when recording stops",
			desc: "When a meeting recording finishes, transcribe it automatically (no dialog) and add the transcript to the meeting note. Requires the shared AI endpoint (base URL + API key) above.",
		},
		retentionDays: {
			name: "Recording retention (days)",
			desc: "Move recordings older than this many days to the trash (audio only). A recording linked to a meeting note is kept until that note is transcribed or enriched, so you never lose audio you haven't captured yet. Runs on startup and via the 'Clean up old recordings' command. 0 keeps recordings forever.",
		},
		actionItemsAsTasks: {
			name: "Action items as tasks",
			desc: "When enriching, lift the AI's action items into checkboxes under '## Action items' so the obsidian-tasks plugin can track them. Existing and completed tasks are preserved.",
		},
		suggestAdhocTitle: {
			name: "Suggest a title for unplanned meetings",
			desc: "After enriching an unplanned (ad-hoc or detected) meeting, ask the LLM for a title and offer to rename the note, keeping the date prefix. Scheduled meetings keep their calendar title.",
		},
		calendarHeading: "Google Calendar integration",
		clientId: {
			name: "Client ID",
			desc: "The client ID issued by Google.",
		},
		clientSecret: {
			name: "Client secret",
			desc: "The client secret issued by Google.",
		},
		googleAuth: {
			name: "Google authentication",
			descAuthenticated: "Authenticated. Re-authenticating refreshes the token.",
			descUnauthenticated:
				"Not authenticated. Set the client ID and secret, then authenticate.",
			buttonReauthenticate: "Re-authenticate",
			buttonAuthenticate: "Authenticate",
		},
		calendarAutoRecord: {
			name: "Calendar auto-recording",
			desc: "Shows a notification to start recording at each event's start time.",
		},
		targetCalendarId: {
			name: "Target calendar ID",
			desc: "ID of the calendar to watch. The default `primary` is your main calendar.",
		},
		exclusionKeywords: {
			name: "Exclusion keywords",
			desc: "Events whose title contains any of these words are excluded from the calendar entirely — not shown in the agenda and not recorded (separate by newline or comma; case-insensitive).",
		},
		openMeet: {
			name: "Open Meet automatically",
			desc: "If the event has a meeting link, open it in the browser at the start time.",
		},
		agendaLookAhead: {
			name: "Agenda look-ahead (days)",
			desc: "How many upcoming days the meeting agenda renders.",
		},
		agendaLookBack: {
			name: "Agenda look-back (days)",
			desc: "How many past days you can navigate back to in the agenda (0–30).",
		},
		detectionHeading: "Meeting detection (macOS)",
		detectMeetings: {
			name: "Detect meetings automatically",
			desc: "Watch for an in-progress meeting and offer to record it (even without a calendar event). Shows a native notification you'll see when Obsidian is minimized. macOS only.",
		},
		detectZoom: {
			name: "Detect Zoom",
			desc: "Detect an active Zoom call via its in-meeting helper process (only running during a call, not when Zoom is merely open).",
		},
		detectGoogleMeet: {
			name: "Detect Google Meet",
			desc: "Detect a live meet.google.com tab in Chrome, Brave, Edge, or Arc. Requires granting Obsidian Automation permission the first time.",
		},
		detectionInterval: {
			name: "Detection interval (seconds)",
			desc: "How often to check for a meeting in progress (3–120).",
		},
		endpointHeading: "AI endpoint",
		apiBaseUrl: {
			name: "API base URL",
			desc: "OpenAI-compatible endpoint used for both transcription (/audio/transcriptions) and enrichment (/chat/completions). OpenAI and LiteLLM work for both. Ollama works for enrichment only — it has no /audio/transcriptions endpoint. Azure requires the OpenAI-compatible surface (/openai/v1), not the classic deployment-path format.",
		},
		apiKey: {
			name: "API key",
			desc: "Sent as a Bearer token for transcription and enrichment. Stored in this vault's plugin data. Use 'Test connection' to verify it and load the available models.",
		},
		transcriptionHeading: "Transcription",
		sttModel: {
			name: "Transcription model",
			desc: "Model sent to the endpoint. Run 'Test connection' above to load the models your endpoint exposes, then pick one (or type a gateway deployment name such as llm-gateway/whisper).",
		},
		sttApiType: {
			name: "Transcription API",
			desc: "Which speech-to-text API the model above speaks. Auto-detected from the model name; override it if your gateway renames models. Controls request shape, chunking, and word timestamps.",
			gpt4o: "GPT-4o (most accurate)",
			gpt4oMini: "GPT-4o mini (lower cost)",
			whisper: "Whisper",
			whisperTs: "Whisper (word timestamps)",
		},
		sttLanguage: {
			name: "Language",
			desc: "ISO 639-1 code (e.g. en, ja, ko, zh, es, de, fr) or 'auto' to detect. Use the two-letter code — full names like 'Spanish' will cause a 400 error from the API.",
		},
		dictionaryCorrection: {
			name: "Custom dictionary correction",
			desc: "Apply the rules below to fix misheard names and terms after transcription.",
		},
		postProcessing: {
			name: "GPT-assisted dictionary correction",
			desc: "Use the model (instead of plain find-and-replace) to apply the dictionary more intelligently. Requires 'Custom dictionary correction' above.",
		},
		dictionary: {
			name: "Dictionary",
			desc: "One rule per line: misheard => correct. Example: elastic search => Elasticsearch. The top 50 rules by priority are applied — rules beyond that are silently ignored.",
			placeholder: "elastic search => Elasticsearch\nkubernetis => Kubernetes",
		},
		recordingHeading: "Recording & notes",
		enrichHeading: "AI enrichment",
		enableEnrichment: {
			name: "Enable AI enrichment",
			desc: "Allow generating an AI notes summary from your notes and the transcript.",
		},
		enrichModel: {
			name: "Model",
			desc: "Chat model used for enrichment. Use 'Test connection' to load the models your endpoint exposes, then pick one from the dropdown.",
		},
		testConnection: {
			button: "Test connection",
			testing: "Testing…",
			noBaseUrl: "Set the API base URL first.",
			success: (n: number) =>
				`Connected. Loaded ${n} model${n === 1 ? "" : "s"}.`,
			empty: "Connected, but the endpoint returned no models.",
			failure: (msg: string) => `Connection failed: ${msg}`,
		},
		enrichOnTranscribe: {
			name: "Enrich automatically after transcription",
			desc: "Run enrichment as soon as a transcript is inserted. On by default; turn it off if you want to trigger enrichment manually.",
		},
		enrichPrompt: {
			name: "Enrichment prompt",
			desc: "Prompt sent to the model. Placeholders: {{title}}, {{date}}, {{attendees}}, {{notes}}, {{transcript}}.",
		},
	},
	oauth: {
		notAuthenticated:
			"Not authenticated. Please authenticate from the command palette.",
		credentialsNotSet: "OAuth credentials are not set.",
		sessionExpired:
			"Google Calendar session expired. Please reconnect from settings or the command palette.",
		desktopOnly: "OAuth authentication is only supported on desktop.",
		setCredentialsFirst: "Please set the OAuth Client ID / Secret first.",
		openingBrowser: "Opening Google authentication in your browser…",
		noRefreshToken:
			"No refresh_token was returned. Add yourself as a test user on the OAuth consent screen and try again.",
		authComplete: "✅ Calendar authentication complete",
		timeout: "Authentication timed out (5 minutes).",
		htmlError: (err: string) => `<h1>OAuth error</h1><p>${err}</p>`,
		htmlStateMismatch: "<h1>state mismatch</h1>",
		htmlCodeMissing: "<h1>code missing</h1>",
		htmlSuccess: `<!doctype html><html><head><title>Authentication complete</title></head><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>✅ Authentication complete</h1><p>Close this tab and return to Obsidian.</p></body></html>`,
	},
};

export type Messages = typeof en;
