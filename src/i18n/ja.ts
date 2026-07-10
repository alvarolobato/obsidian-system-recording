import type { Messages } from "./en";

// Japanese locale. Preserves the plugin's original strings verbatim.
export const ja: Messages = {
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
		autoRecordEnabled: "カレンダー自動録音を有効化しました",
		autoRecordDisabled: "カレンダー自動録音を無効化しました",
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
		started: (title: string) => `「${title}」が始まりました`,
		ended: (title: string) => `「${title}」が終了しました`,
		startRecordingAction: "録音開始",
		createNoteAndRecord: "ノートを作成して録音開始",
		stopRecordingAction: "録音停止",
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
			name: "会議フォルダ",
			desc: "会議ノートと録音の保存先フォルダ。繰り返しの予定は専用のサブフォルダに保存します。",
			placeholder: "Meetings",
		},
		retentionDays: {
			name: "録音の保持日数",
			desc: "文字起こし後、録音は m4a に圧縮され、この日数を過ぎると削除されます。0 で無期限に保持します。",
		},
		calendarHeading: "Google カレンダー連携",
		clientId: {
			name: "クライアント ID",
			desc: "Google で発行したクライアント ID。",
		},
		clientSecret: {
			name: "クライアントシークレット",
			desc: "Google で発行したクライアントシークレット。",
		},
		googleAuth: {
			name: "Google 認証",
			descAuthenticated: "認証済み。再認証するとトークンを更新します。",
			descUnauthenticated:
				"未認証。クライアント ID とシークレットを設定してから認証してください。",
			buttonReauthenticate: "再認証",
			buttonAuthenticate: "認証する",
		},
		calendarAutoRecord: {
			name: "カレンダー自動録音",
			desc: "予定の開始時刻に録音開始の通知を出します。",
		},
		targetCalendarId: {
			name: "対象カレンダー ID",
			desc: "監視するカレンダーの ID。既定の primary はメインカレンダー。",
		},
		exclusionKeywords: {
			name: "除外キーワード",
			desc: "タイトルにこれらの語を含む予定は録音しません（改行またはカンマ区切り、大文字小文字無視）。",
		},
		openMeet: {
			name: "Meet を自動で開く",
			desc: "予定に会議リンクがあれば開始時刻にブラウザで開きます。",
		},
	},
	oauth: {
		notAuthenticated: "認証されていません。コマンドパレットで認証してください。",
		credentialsNotSet: "OAuth credentials が未設定です。",
		desktopOnly: "OAuth認証はデスクトップ版のみ対応です。",
		setCredentialsFirst: "先に OAuth Client ID / Secret を設定してください。",
		openingBrowser: "Google 認証をブラウザで開きます…",
		noRefreshToken:
			"refresh_token が返ってきません。OAuth 同意画面のテストユーザーに自分を追加して再試行してください。",
		authComplete: "✅ カレンダー認証が完了しました",
		timeout: "認証がタイムアウトしました (5分)。",
		htmlError: (err: string) => `<h1>OAuth エラー</h1><p>${err}</p>`,
		htmlStateMismatch: `<h1>state 不一致</h1>`,
		htmlCodeMissing: `<h1>code がありません</h1>`,
		htmlSuccess: `<!doctype html><html><head><title>認証完了</title></head><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>✅ 認証完了</h1><p>このタブを閉じて Obsidian に戻ってください。</p></body></html>`,
	},
};
