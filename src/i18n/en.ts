// English locale.
export const en = {
	ribbon: {
		toggleRecording: "Toggle recording",
	},
	commands: {
		startRecording: "Start recording",
		stopRecording: "Stop recording",
		authenticateCalendar: "Authenticate calendar",
		toggleCalendarAutoRecording: "Toggle calendar auto-recording",
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
		retentionDays: {
			name: "Recording retention (days)",
			desc: "After transcription, recordings are compressed to m4a and deleted once older than this. 0 keeps them forever.",
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
			desc: "Events whose title contains any of these words are not recorded (separate by newline or comma; case-insensitive).",
		},
		openMeet: {
			name: "Open Meet automatically",
			desc: "If the event has a meeting link, open it in the browser at the start time.",
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
