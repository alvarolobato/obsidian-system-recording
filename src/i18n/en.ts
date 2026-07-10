// English locale.
export const en = {
	ribbon: {
		toggleRecording: "Toggle recording",
		openAgenda: "Open meeting agenda",
	},
	commands: {
		startRecording: "Start recording",
		stopRecording: "Stop recording",
		authenticateCalendar: "Authenticate calendar",
		toggleCalendarAutoRecording: "Toggle calendar auto-recording",
		openAgenda: "Open meeting agenda",
		enrichNote: "Enrich meeting note (AI)",
		toggleAiNotes: "Toggle AI notes visibility",
	},
	notices: {
		autoRecordEnabled: "Calendar auto-recording enabled",
		autoRecordDisabled: "Calendar auto-recording disabled",
		recordingError: (msg: string) => `Recording error: ${msg}`,
		alreadyRecording: "Already recording",
		macOnly: "System recording is only supported on macOS",
		downloadingHelper: "Downloading recorder helper…",
		recordingStarted: "Recording started",
		notRecording: "Not recording",
		stoppingRecording: "Stopping recording...",
		calendarError: (msg: string) => `Calendar error: ${msg}`,
		recordingSaved: "Recording saved",
		unknownError: "Unknown error",
		transcriptAdded: (note: string) => `Transcript added to ${note}`,
		enriching: "Enriching meeting note…",
		enrichDone: (note: string) => `Enriched ${note}`,
		enrichError: (msg: string) => `Enrichment failed: ${msg}`,
		enrichNotConfigured:
			"Set the enrichment base URL, API key and model in settings first.",
		enrichDisabled: "AI enrichment is disabled in settings.",
		nothingToEnrich: "No notes or transcript to enrich in this note.",
		notAMeetingNote: "Open a meeting note to enrich it.",
		aiNotesHidden: "AI notes hidden",
		aiNotesShown: "AI notes shown",
	},
	statusBar: {
		recording: (hms: string) => `Recording ${hms}`,
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
			transcriberMissing:
				"AI Transcriber not found. Open the recording and run it manually.",
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
		meetingsFolder: {
			name: "Meetings folder",
			desc: "Folder for meeting notes and their recordings. Recurring meetings get their own subfolder.",
			placeholder: "Meetings",
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
			desc: "When AI Transcriber finishes, write the transcript into the matching meeting note's ## Transcript section and mark it transcribed.",
		},
		retentionDays: {
			name: "Recording retention (days)",
			desc: "Planned — not yet enforced. Intended to clean up recordings older than this many days. 0 keeps them forever.",
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
		enrichHeading: "AI enrichment",
		enableEnrichment: {
			name: "Enable AI enrichment",
			desc: "Allow generating an AI notes summary from your notes and the transcript.",
		},
		enrichBaseUrl: {
			name: "API base URL",
			desc: "OpenAI-compatible endpoint (OpenAI, Azure, a LiteLLM proxy, Ollama, …). The /chat/completions path is appended.",
		},
		enrichApiKey: {
			name: "API key",
			desc: "Sent as a Bearer token. Stored in this vault's plugin data.",
		},
		enrichModel: {
			name: "Model",
			desc: "Chat model name, e.g. gpt-4o.",
		},
		enrichOnTranscribe: {
			name: "Enrich automatically after transcription",
			desc: "Run enrichment as soon as a transcript is inserted. Off by default to avoid unexpected API calls.",
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
