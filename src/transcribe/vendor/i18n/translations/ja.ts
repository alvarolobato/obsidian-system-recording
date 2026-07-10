/**
 * Japanese translations
 */

import type { TranslationKeys } from '../locales';

const ja: TranslationKeys = {
	// Plugin info
	plugin: {
		name: 'AI Transcriber' // Not translated
	},

	// Settings
	settings: {
		title: 'AI Transcriber 設定',
		apiKey: {
			name: 'OpenAI APIキー',
			desc: 'OpenAIのAPIキーを入力してください',
			placeholder: 'OpenAI APIキーを入力',
			testButton: '接続テスト',
			testSuccess: '接続成功',
			testFailed: '接続に失敗しました。APIキーを確認してください。',
			insecureWarning: 'OS暗号化が利用できません。代替の暗号化方式を使用します。',
			migrated: 'APIキーを新しい暗号化方式へ自動移行しました。'
		},
		model: {
			name: '標準の文字起こしモデル',
			desc: '文字起こしに使用するAIモデルを選択',
			comparison: 'モデル比較:',
			whisper: 'Whisper-1',
			whisperDesc: 'タイムスタンプ付き出力も可能',
			gpt4o: 'GPT-4o Transcribe',
			gpt4oDesc: '高精度',
			gpt4oMini: 'GPT-4o Mini Transcribe',
			gpt4oMiniDesc: '低コスト',
			whisperNoTimestamp: 'Whisper-1 (タイムスタンプなし)',
			whisperWithTimestamp: 'Whisper-1 (タイムスタンプあり)',
			gpt4oHigh: 'GPT-4o Transcribe',
			gpt4oMiniCost: 'GPT-4o Mini Transcribe'
		},
		vadMode: {
			name: '無音検出（VAD）方式',
			desc: '無音区間の処理により、音声認識処理の軽減や送信データ量の削減が図れます',
			options: {
				server: 'サーバー',
				local: 'ローカル',
				disabled: '処理なし'
			},
			summaries: {
				server: '標準：処理速度向上',
				local: '高度：速度向上・通信量削減',
				disabled: '無音の処理を行いません'
			},
			missingWarning: 'ローカルVADの使用にはサードパーティのモジュールが必要です。fvad-wasmリポジトリからfvad.wasmファイルをダウンロードし、「ファイルを選択」ボタンを押してプラグインフォルダにコピーしてください。',
			missingInlineNote: 'ローカルVADの使用にはサードパーティのモジュールが必要です。fvad-wasmリポジトリからfvad.wasmファイルをダウンロードし、「ファイルを選択」ボタンを押してプラグインフォルダにコピーしてください。',
			localNote: '端末内で無音箇所を送信前に削除するため、APIコストの削減につながります。',
			installWasm: {
				name: 'fvad.wasm を配置',
				desc: '取得済みの fvad.wasm を選択すると自動でプラグインフォルダに配置します',
				button: 'ファイルを選択',
				success: 'fvad.wasm を配置しました',
				invalidName: 'fvad.wasm を選択してください',
				invalidType: '有効なWASMファイルではありません',
				writeError: '配置に失敗しました: {error}'
			}
		},
		language: {
			name: '言語',
			desc: '文字起こしの主要言語',
			autoDetect: '自動検出',
			useObsidianLang: 'Obsidianの言語を使用',
			options: {
				ja: '日本語',
				en: '英語',
				zh: '中国語',
				ko: '韓国語'
			}
		},
		outputFormat: {
			name: '出力形式',
			desc: '文字起こし結果の出力形式',
			callout: 'コールアウトブロック',
			quote: '引用ブロック',
			plain: 'プレーンテキスト'
		},
		postProcessing: {
			name: '後処理を有効化',
			desc: '文字起こし完了後、関連情報を使用してAIで後処理を行う'
		},
		dictionaryCorrection: {
			name: '辞書補正を有効化',
			desc: '文字起こし結果を辞書ベースで自動補正する'
		},
		outputFolder: {
			name: '出力フォルダ',
			desc: '文字起こし結果を保存するフォルダを指定（空欄の場合はVaultルート）',
			placeholder: '例: Transcriptions',
			select: 'フォルダを選択'
		},
		advanced: {
			title: '詳細設定',
			chunkInfo: 'チャンク設定ガイド:',
			chunk180s: '180秒 (3分): 推奨 - タイムアウトを回避',
			chunk300s: '300秒 (5分): デフォルト - バランスの取れたパフォーマンス',
			chunk600s: '600秒 (10分): 最大 - タイムアウトの可能性あり',
			chunkNote: '注意: 小さいチャンクはより信頼性が高いですが、APIコールが増える可能性があります'
		},
		progressUI: {
			title: '進行状況UI設定',
			statusBar: 'ステータスバーを表示',
			statusBarDesc: 'ステータスバーに文字起こしの進行状況を表示',
			autoOpen: 'サイドパネルを自動で開く',
			autoOpenDesc: '文字起こし開始時に自動でサイドパネルを開く',
			maxHistory: '最大履歴件数',
			maxHistoryDesc: '保持する文字起こし履歴の件数 (10-100)'
		},
		debug: {
			mode: 'デバッグモード',
			modeDesc: '詳細なコンソールログを出力します（開発者向け）'
		},
		dictionary: {
			name: 'ユーザー辞書',
			desc: '音声認識の誤認識パターンを修正する辞書を編集できます',
			addButton: '+ 追加',
			deleteButton: '削除',
			from: '変換元',
			to: '変換先',
			enabled: '有効',
			category: 'カテゴリ',
			priority: '優先度',
			context: 'コンテキスト',
			definiteCorrections: '固定補正',
			contextualCorrections: '文脈補正',
			importExport: 'インポート/エクスポート',
			importExportDesc: '辞書データをJSON形式でインポート/エクスポートできます',
			import: 'インポート',
			export: 'エクスポート',
			importSuccess: '辞書をインポートしました',
			exportSuccess: '辞書をエクスポートしました',
			importError: 'インポートエラー: ',
			noDataToExport: 'エクスポートするデータがありません',
			exportError: 'エクスポートに失敗しました',
			importConfirm: '既存の辞書データはどうしますか？',
			replace: '置き換える',
			merge: '統合する',
			manageDictionary: '辞書管理',
			manageDictionaryDesc: 'ユーザー辞書の編集と管理を行います',
			openManager: '辞書を管理',
			title: 'ユーザー辞書管理',
			fromPlaceholder: '変換元 (カンマ区切りで複数可)',
			toPlaceholder: '変換先',
			autoModeDesc: '言語自動検出時は全言語の辞書が適用されます。※固定補正は自動置換、文脈補正はキーワードが含まれる場合に適用されます',
			languageModeDesc: '{lang}の辞書のみが適用されます。※固定補正は自動置換、文脈補正はキーワードが含まれる場合に適用されます',
			contextPlaceholder: 'キーワード (カンマ区切り)',
			limitReached: '辞書項目数が上限({limit}件)に達しました',
			categories: {
				noun: '名詞',
				person: '人名',
				place: '地名',
				org: '組織名',
				proper: '固有名詞',
				technical: '専門用語',
				spoken: '話し言葉',
				symbol: '記号・単位'
			}
		},
		connection: {
			title: '接続テスト',
			name: 'API接続をテスト',
			desc: 'APIキーと接続状態を確認します',
			testButton: '接続テスト',
			testing: 'テスト中...',
			successNotice: '✅ {provider} への接続に成功しました！',
			successButton: '✅ 接続済み',
			failureNotice: '❌ {provider} への接続に失敗しました。APIキーを確認してください。',
			failureButton: '❌ 失敗',
			errorNotice: '❌ 接続テストでエラー: {error}',
			errorButton: '❌ エラー',
			clearTitle: 'APIキーを削除',
			clearDesc: '保存済みのAPIキーをすべて削除します（トラブルシューティング向け）',
			clearButton: 'キーをすべて削除',
			clearedNotice: 'APIキーを削除しました'
		}
	},

	// プロバイダー名
	providers: {
		openai: 'OpenAI',
		whisper: 'OpenAI Whisper',
		whisperTs: 'OpenAI Whisper（タイムスタンプあり）',
		gpt4o: 'GPT-4o Transcribe',
		gpt4oMini: 'GPT-4o Mini Transcribe'
	},

	// Commands
	commands: {
		transcribeAudio: '音声ファイルを文字起こし (API)',
		openPanel: '文字起こしパネルを開く',
		contextMenu: 'AIで文字起こし'
	},

	// Ribbon
	ribbon: {
		tooltip: 'AI Transcriber'
	},

	// Status bar
	statusBar: {
		processing: '文字起こし中',
		completed: '文字起こし完了',
		failed: '文字起こし失敗',
		cancelled: '文字起こしキャンセル',
		clickToOpen: 'クリックして詳細を表示'
	},

	// Notices
	notices: {
		apiKeyNotConfigured: 'APIキーが設定されていません。設定でOpenAI APIキーを追加してください。',
		apiKeyMissing: 'APIキーが設定されていません。設定でOpenAI APIキーを追加してください。',
		transcriptionComplete: '文字起こしが正常に完了しました',
		transcriptionFailed: '文字起こしに失敗しました。もう一度お試しください。',
		transcriptionCancelled: '文字起こしがキャンセルされました',
		noAudioFile: '音声ファイルが選択されていません',
		processingFile: 'ファイルを処理中: {fileName}',
		vadInitError: 'VAD初期化エラー: fvad.wasmファイルが見つかりません。プラグインフォルダに配置してください。',
		vadServerFallback: 'ローカルのVADモジュールが見つからなかったため、サーバー側のVADに切り替えました。',
		vadProcessingError: 'VAD処理エラー: {error}',
		vadUnavailable: 'VADが利用できないため、無音除去なしで処理を続行します。',
		externalFileNotSupported: '外部ファイルの処理は次のフェーズで実装予定です',
		postProcessingComplete: '後処理完了: {model}を使用',
		postProcessingFailed: '後処理に失敗しました。元の文字起こし結果を使用します。',
		languageSet: '言語を設定: {language}',
		settingsSaved: '設定を保存しました',
		largeFileWarning: '大きなファイル（{size} MB）の処理には時間がかかる場合があります',
		unsupportedFormat: 'サポートされていない音声形式: {format}',
		legacyHistoryItem: '旧バージョンの履歴項目のため、ファイルパスが記録されていません',
		backgroundProcessingStarted: '文字起こしをバックグラウンドで開始しました。進捗はステータスバーで確認できます。',
		backgroundProcessingError: 'バックグラウンド処理でエラー: {message}',
		partialTranscriptionComplete: '部分的な文字起こし完了: {count}文字を生成（一部エラーあり）',
		transcriptionCompleteDetailed: '文字起こし完了: {count}文字を生成{details}',
		postProcessingSuffix: '（後処理: {model}）',
		transcriptionAppendedFallback: '挿入エラーが発生したため、文字起こしをファイル末尾に追記しました。',
		transcriptionSavedToNewFile: '文字起こしを新規ファイルに保存しました: {fileName}',
		transcriptionManualRecovery: '文字起こしの保存に失敗しました。復旧用ウィンドウに生成内容を表示しています。'
	},

	// Transcription Modal
	modal: {
		// Common modal buttons
		button: {
			ok: 'OK',
			cancel: 'キャンセル'
		},
		audioFileSelection: {
			title: '音声ファイルを選択',
			searchPlaceholder: 'ファイル名で検索...',
			sortBy: 'ソート:',
			sortByCreated: '作成日時',
			sortByModified: '更新日時',
			sortByDate: '更新日',
			sortByName: 'ファイル名',
			sortByPath: 'パス',
			fileName: 'ファイル名',
			fileCreated: '作成日時',
			filePath: 'パス',
			noFiles: '音声ファイルが見つかりません',
			selectExternal: 'Vault外から選択',
			copying: 'ファイルをコピー中...',
			externalFileNotice: 'Vault外から選択する場合、Obsidianの制約上一時的にVault内のフォルダにコピーして処理されます。\nコピーしたファイルは次回起動時に削除されます。'
		},
		transcription: {
			title: 'AI Transcriber',
			fileInfo: 'ファイル情報',
			modelLabel: '文字起こしAIモデル',
			fileSize: 'サイズ: {size}',
			fileType: 'ファイルタイプ: {type}',
			audioFile: '音声ファイル',
			videoFile: '動画ファイル',
			extractingAudio: '動画から音声を抽出中',
			largeFileWarning: '大きなファイル（{size} MB）の処理には時間がかかる場合があります',
			costEstimate: '推定コスト',
			costNote: '実際のコストは処理内容により変動する可能性があります',
			costDetails: 'モデル: {model} • レート: {rate}',
			additionalProcessingCostNote: 'この金額は文字起こし分のみです。AI後処理やユーザー辞書補正を使うと、追加のAPI費用が発生し、推定コストを上回る場合があります。',
			timeRange: '時間範囲',
			selectTimeRange: '特定の時間範囲を選択（オプション）',
			startTime: '開始',
			endTime: '終了',
			duration: '長さ: {duration}',
			metaInfoButton: '関連情報入力',
			metaInfoButtonFilled: '関連情報入力済み',
			processingOptions: {
				title: '処理オプション',
				enablePostProcessing: 'AI後処理を有効化',
				enablePostProcessingDesc: '追加のAPI呼び出しを行うため、上記の推定コストを上回る場合があります。',
				enableDictionaryCorrection: 'ユーザー辞書を後処理に使う',
				enableDictionaryCorrectionDesc: '辞書補正にも追加のAPI費用が発生する場合があります。',
				outputFolder: '出力フォルダ',
				relatedInfo: '関連情報'
			},
			startButton: '文字起こし開始',
			cancelButton: 'キャンセル',
			processing: '処理中',
			preparingAudio: '音声を準備中',
			transcribing: '文字起こし中',
			postProcessing: 'AIで後処理中',
			postProcessingCompleted: '後処理が完了しました',
			savingResults: '結果を保存中',
			completed: '完了',
			partialResult: '[部分的な文字起こし結果]',
			partialSummary: '{total}チャンク中{processed}チャンクを処理しました。',
			partialCancelled: '文字起こしをキャンセルしました。{total}チャンク中{processed}チャンクが完了しています。',
			partialError: 'エラーにより部分的な文字起こしになりました（{error}）。{total}チャンク中{processed}チャンクが完了しています。',
			partialNoChunks: '文字起こしは開始前にキャンセルされました（処理済みのチャンクはありません）。',
			partialFailedChunks: '一部のチャンク（{chunks}）で失敗しました。',
			chunkFailure: '[チャンク{index}で失敗: {error}]',
			chunkFailureSummary: 'チャンク{ id }: {error}',
			costEstimateSummary: '約{minutes}分 @ {rate}/分',
			manualRecoveryTitle: '文字起こしを復旧',
			manualRecoveryDescription: '生成したノートを保存できませんでした。以下のテキストを使って、文字起こしを手動で復旧してください。',
			manualRecoveryTarget: '保存予定ファイル: {path}',
			manualRecoveryError: '保存エラー: {error}',
			manualRecoverySelectText: 'テキストを選択'
		},
		postProcessing: {
			titlePre: '関連情報の事前入力',
			titlePost: '転写後の後処理',
			transcriptionPreview: '文字起こしプレビュー',
			relatedInfo: '関連情報',
			metaInfoPlaceholder: '例: 話者（山田太郎、鈴木花子）、トピック（AI技術、機械学習）、専門用語（ニューラルネットワーク、深層学習）、コンテキスト（会議、インタビュー）など、音声の内容に関連する情報を自由に入力してください。',
			metaInfoDescription: '音声の内容や話者に関する情報を自由に入力してください。この情報はAIがより正確な文字起こしや後処理を行うために使用されます。',
			emptyInputError: '関連情報を入力してください。',
			templateOnlyError: 'テンプレートの例を参考に、実際の情報を入力してください。',
			options: 'オプション',
			enablePostProcessing: '関連情報を使用して文字起こしを後処理する',
			processButton: '処理',
			cancelButton: 'キャンセル',
			processing: '処理中'
		}
	},

	// Errors
	errors: {
		general: 'エラーが発生しました',
		audioLoad: '音声ファイルの読み込みに失敗しました',
		audioProcess: '音声の処理に失敗しました',
		apiError: 'APIエラー: {error}',
		networkError: 'ネットワークエラー。接続を確認してください。',
		timeout: 'リクエストがタイムアウトしました',
		cancelled: '操作がキャンセルされました',
		invalidResponse: 'サーバーからの無効な応答',
		vadInitFailed: 'VAD初期化失敗: {error}',
		vadProcessFailed: 'VAD処理失敗: {error}',
		apiKeyMissing: 'APIキーが入力されていません',
		invalidApiKeyFormat: 'APIキーの形式が無効です。"sk-"で始まる必要があります',
		invalidApiKey: '無効なAPIキーです',
		rateLimitExceeded: 'レート制限に達しました。しばらく待ってから再試行してください',
		apiUnavailable: 'OpenAI APIが一時的に利用できません',
		apiConnectionFailed: 'API接続に失敗しました (ステータス: {status})',
		chunkingFailed: '音声のチャンク化に失敗しました',
		mergingFailed: '文字起こしチャンクの結合に失敗しました',
		saveFailed: '文字起こしの保存に失敗しました',
		createFileFailed: '文字起こしファイルの作成に失敗しました: {error}',
		validationFailed: '検証に失敗しました: {details}',
		transcriptionCancelledByUser: 'ユーザーによって文字起こしがキャンセルされました',
		unsupportedAudioFormat: '未対応の音声形式です: {extension}。対応形式: {formats}',
		audioValidationFailed: '音声検証に失敗しました: {error}',
		noTranscriptionResults: '文字起こし結果を取得できませんでした',
		costEstimateUnavailable: 'コストを見積もれませんでした',
		settingsLoad: '設定の読み込みに失敗しました',
		settingsSave: '設定の保存に失敗しました',
		fileNotFound: '文字起こしファイルが見つかりません',
		// Error Handler specific
		titles: {
			apiKeyCheck: 'APIキー確認',
			apiUsageLimit: 'API使用制限',
			apiConnection: 'API接続',
			fileError: 'ファイルエラー',
			fileAccessError: 'ファイルアクセスエラー',
			fileLoadError: 'ファイル読み込みエラー',
			networkError: 'ネットワークエラー',
			audioProcessError: '音声処理エラー',
			fileSizeError: 'ファイルサイズエラー',
			unexpectedError: '予期しないエラー'
		},
		messages: {
			apiKeyRecheck: 'APIキーをもう一度確認してみてください。',
			apiUsageLimitReached: 'APIの使用制限に達しました。しばらく時間をおいてから再試行してください。',
			apiConnectionIssue: '接続に問題があるようです。APIキーを確認してみてください。',
			apiConnectionFailedDetailed: 'API接続に失敗しました。APIキーとネットワーク接続を確認してください。',
			fileNotFound: '文字起こしファイルが見つかりません。ファイルが移動または削除されていないか確認してください。',
			fileAccessDenied: 'ファイルにアクセスできません。ファイルの権限を確認してください。',
			fileLoadFailed: '音声ファイルの読み込みに失敗しました。ファイル形式（MP3, WAV, M4A等）を確認してください。',
			networkConnectionIssue: 'インターネット接続を確認してください。接続が安定してから再試行してください。',
			audioProcessFailed: '音声ファイルの処理に失敗しました。ファイルが破損していないか、対応形式かを確認してください。',
			fileSizeExceeded: 'ファイルサイズが制限を超えています（最大500MB）。',
			diskSpaceLow: '使用可能な容量が不足しています（残り: {available}GB）。',
			unexpectedErrorOccurred: '処理中にエラーが発生しました。しばらく時間をおいてから再試行してください。',
			noAudioTrack: '動画ファイルに音声トラックが含まれていません。',
			unsupportedVideoCodec: 'サポートされていない動画コーデックです。別の形式に変換してください。',
			noTranscriptionText: '文字起こし結果が生成されませんでした。音声状態を確認して再度お試しください。',
			invalidTimeRange: '開始時刻は終了時刻より前である必要があります。',
			endTimeExceedsDuration: '終了時刻（{end}）が音声の長さ（{duration}）を超えています。',
			unableToOpenFile: '作成したファイルを開けませんでした。',
			fileInsertionFailed: 'ファイルへの挿入に失敗しました。復旧用ウィンドウに文字起こし本文を表示しています。'
		},
		recoveryActions: {
			openSettings: '設定を開く',
			connectionTest: '接続テスト',
			checkSupportedFormats: '対応形式を確認',
			retry: '再試行',
			tryOtherFormat: '他のファイル形式で試す',
			checkSizeLimit: 'サイズ制限を確認',
			enableDebugMode: 'デバッグモードを有効化'
		},
		notices: {
			settingsCheck: '設定画面でAPIキーを確認してください',
			settingsConnectionTest: '設定画面の「接続テスト」ボタンをお試しください',
			supportedFormats: '対応形式: 音声(MP3, WAV, M4A, FLAC, AAC, OGG)、動画(MP4, M4V, MOV, AVI, MKV, WebM)',
			networkRetry: 'ネットワーク接続を確認してから再度お試しください',
			formatConversion: 'WAVやMP3形式に変換してから再度お試しください',
			sizeLimit: 'GPT-4o: 20MB/25分、Whisper: 20MB',
			debugModeEnable: '設定画面でデバッグモードを有効にすると詳細ログが確認できます'
		}
	},

	// Units
	units: {
		seconds: '秒',
		minutes: '分',
		hours: '時間',
		mb: 'MB',
		gb: 'GB'
	},

	// Audio Range Selection
	audioRange: {
		title: '音声範囲選択',
		description: '特定の時間範囲を選択してハルシネーションと処理時間を削減',
		audioDuration: '音声の長さ',
		enableSelection: '時間範囲選択を有効にする',
		startTime: '開始',
		endTime: '終了'
	},

	// Common
	common: {
		noHistory: '文字起こし履歴がありません',
		noActiveTask: '現在処理中のタスクはありません',
		loading: '読み込み中',
		idle: '待機中',
		processing: '処理中',
		completed: '完了',
		partial: '部分完了',
		failed: '失敗',
		cancelled: 'キャンセル',
		retry: '再試行',
		close: '閉じる',
		save: '保存',
		cancel: 'キャンセル',
		delete: '削除',
		confirm: '確認',
		yes: 'はい',
		no: 'いいえ',
		ok: 'OK',
		error: 'エラー',
		warning: '警告',
		info: '情報',
		success: '成功',
		history: '文字起こし履歴',
		progressStatus: '進捗状況',
		searchForFile: '文字起こし日時「{timestamp}」でファイルを検索しますか？',
		search: '検索',
		elapsedTime: '経過時間',
		manualSearchRequired: '自動検索で見つかりませんでした。手動で検索してください。',
		multipleAudioFilesFound: '複数の音声ファイルが見つかりました',
		historyUpdated: '履歴を更新しました',
		selectFile: 'ファイルを選択',
		multipleFilesFound: '複数のファイルが見つかりました。選択してください：',
		fileSize: {
			zero: '0 バイト',
			units: {
				bytes: 'バイト',
				kb: 'KB',
				mb: 'MB',
				gb: 'GB'
			}
		}
	},

	// Support section
	support: {
		message: 'このプラグインが役に立ちましたら、開発継続のためにご支援をお願いいたします：',
		imageAlt: 'Buy Me a Coffee で AI Transcriber を支援'
	}
};

export default ja;
