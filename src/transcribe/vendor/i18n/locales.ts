/**
 * Type definitions for internationalization
 */

export interface TranslationKeys {
	// Plugin info
	plugin: {
		name: string; // Plugin name - not translated
	};

	// Settings
	settings: {
		title: string;
		apiKey: {
			name: string;
			desc: string;
			placeholder: string;
			testButton: string;
			testSuccess: string;
			testFailed: string;
			insecureWarning: string;
			migrated: string;
		};
		model: {
			name: string;
			desc: string;
			comparison: string;
			whisper: string;
			whisperDesc: string;
			gpt4o: string;
			gpt4oDesc: string;
			gpt4oMini: string;
			gpt4oMiniDesc: string;
			whisperNoTimestamp: string;
			whisperWithTimestamp: string;
			gpt4oHigh: string;
			gpt4oMiniCost: string;
		};
		vadMode: {
			name: string;
			desc: string;
			options: {
				server: string;
				local: string;
				disabled: string;
			};
			summaries: {
				server: string;
				local: string;
				disabled: string;
			};
			missingWarning: string;
			missingInlineNote: string;
			localNote: string;
			installWasm: {
				name: string;
				desc: string;
				button: string;
				success: string;
				invalidName: string;
				invalidType: string;
				writeError: string;
			};
		};
		language: {
			name: string;
			desc: string;
			autoDetect: string;
			useObsidianLang: string;
			options: {
				ja: string;
				en: string;
				zh: string;
				ko: string;
			};
		};
		outputFormat: {
			name: string;
			desc: string;
			callout: string;
			quote: string;
			plain: string;
		};
		postProcessing: {
			name: string;
			desc: string;
		};
		dictionaryCorrection: {
			name: string;
			desc: string;
		};
		outputFolder: {
			name: string;
			desc: string;
			placeholder: string;
			select: string;
		};
		advanced: {
			title: string;
			chunkInfo: string;
			chunk180s: string;
			chunk300s: string;
			chunk600s: string;
			chunkNote: string;
		};
		progressUI: {
			title: string;
			statusBar: string;
			statusBarDesc: string;
			autoOpen: string;
			autoOpenDesc: string;
			maxHistory: string;
			maxHistoryDesc: string;
		};
		debug: {
			mode: string;
			modeDesc: string;
		};
		dictionary: {
			name: string;
			desc: string;
			addButton: string;
			deleteButton: string;
			from: string;
			to: string;
			enabled: string;
			category: string;
			priority: string;
			context: string;
			definiteCorrections: string;
			contextualCorrections: string;
			importExport: string;
			importExportDesc: string;
			import: string;
			export: string;
			importSuccess: string;
			exportSuccess: string;
			importError: string;
			noDataToExport: string;
			exportError: string;
			importConfirm: string;
			replace: string;
			merge: string;
			manageDictionary: string;
			manageDictionaryDesc: string;
			openManager: string;
			title: string;
			fromPlaceholder: string;
			toPlaceholder: string;
			autoModeDesc: string;
			languageModeDesc: string;
			contextPlaceholder: string;
			limitReached: string;
			categories: {
				noun: string;
				person: string;
				place: string;
				org: string;
				proper: string;
				technical: string;
				spoken: string;
				symbol: string;
			};
		};
		connection: {
			title: string;
			name: string;
			desc: string;
			testButton: string;
			testing: string;
			successNotice: string;
			successButton: string;
			failureNotice: string;
			failureButton: string;
			errorNotice: string;
			errorButton: string;
			clearTitle: string;
			clearDesc: string;
			clearButton: string;
			clearedNotice: string;
		};
	};

	// Provider display names
	providers: {
		openai: string;
		whisper: string;
		whisperTs: string;
		gpt4o: string;
		gpt4oMini: string;
	};

	// Commands
	commands: {
		transcribeAudio: string;
		openPanel: string;
		contextMenu: string;
	};

	// Ribbon
	ribbon: {
		tooltip: string;
	};

	// Status bar
	statusBar: {
		processing: string;
		completed: string;
		failed: string;
		cancelled: string;
		clickToOpen: string;
	};

	// Notices
	notices: {
		apiKeyNotConfigured: string;
		apiKeyMissing: string;
		transcriptionComplete: string;
		transcriptionFailed: string;
		transcriptionCancelled: string;
		noAudioFile: string;
		processingFile: string;
		vadInitError: string;
		vadServerFallback: string;
		vadProcessingError: string;
		vadUnavailable: string;
		postProcessingComplete: string;
		postProcessingFailed: string;
		languageSet: string;
		settingsSaved: string;
		largeFileWarning: string;
		unsupportedFormat: string;
		legacyHistoryItem: string;
		externalFileNotSupported: string;
		backgroundProcessingStarted: string;
		backgroundProcessingError: string;
		partialTranscriptionComplete: string;
		transcriptionCompleteDetailed: string;
		postProcessingSuffix: string;
		transcriptionAppendedFallback: string;
		transcriptionSavedToNewFile: string;
		transcriptionManualRecovery: string;
	};

	// Transcription Modal
	modal: {
		// Common modal buttons
		button: {
			ok: string;
			cancel: string;
		};
		audioFileSelection: {
			title: string;
			searchPlaceholder: string;
			sortBy: string;
			sortByCreated: string;
			sortByModified: string;
			sortByDate: string;
			sortByName: string;
			sortByPath: string;
			fileName: string;
			fileCreated: string;
			filePath: string;
			noFiles: string;
			selectExternal: string;
			copying: string;
			externalFileNotice: string;
		};
		transcription: {
			title: string;
			fileInfo: string;
			modelLabel: string;
			fileSize: string;
			fileType: string;
			audioFile: string;
			videoFile: string;
			extractingAudio: string;
			largeFileWarning: string;
			costEstimate: string;
			costNote: string;
			costDetails: string;
			additionalProcessingCostNote: string;
			timeRange: string;
			selectTimeRange: string;
			startTime: string;
			endTime: string;
			duration: string;
			metaInfoButton: string;
			metaInfoButtonFilled: string;
			processingOptions: {
				title: string;
				enablePostProcessing: string;
				enablePostProcessingDesc: string;
				enableDictionaryCorrection: string;
				enableDictionaryCorrectionDesc: string;
				outputFolder: string;
				relatedInfo: string;
			};
			startButton: string;
			cancelButton: string;
			processing: string;
			preparingAudio: string;
			transcribing: string;
			postProcessing: string;
			postProcessingCompleted: string;
			savingResults: string;
			completed: string;
			partialResult: string;
			partialSummary: string;
			partialCancelled: string;
			partialError: string;
			partialNoChunks: string;
			partialFailedChunks: string;
			chunkFailure: string;
			chunkFailureSummary: string;
			costEstimateSummary: string;
			manualRecoveryTitle: string;
			manualRecoveryDescription: string;
			manualRecoveryTarget: string;
			manualRecoveryError: string;
			manualRecoverySelectText: string;
		};
		postProcessing: {
			titlePre: string;
			titlePost: string;
			transcriptionPreview: string;
			relatedInfo: string;
			metaInfoPlaceholder: string;
			metaInfoDescription: string;
			emptyInputError: string;
			templateOnlyError: string;
			options: string;
			enablePostProcessing: string;
			processButton: string;
			cancelButton: string;
			processing: string;
		};
	};

	// Errors
	errors: {
		general: string;
		audioLoad: string;
		audioProcess: string;
		apiError: string;
		networkError: string;
		timeout: string;
		cancelled: string;
		invalidResponse: string;
		vadInitFailed: string;
		vadProcessFailed: string;
		apiKeyMissing: string;
		invalidApiKeyFormat: string;
		invalidApiKey: string;
		rateLimitExceeded: string;
		apiUnavailable: string;
		apiConnectionFailed: string;
		chunkingFailed: string;
		mergingFailed: string;
		saveFailed: string;
		createFileFailed: string;
		validationFailed: string;
		transcriptionCancelledByUser: string;
		unsupportedAudioFormat: string;
		audioValidationFailed: string;
		noTranscriptionResults: string;
		costEstimateUnavailable: string;
		settingsLoad: string;
		settingsSave: string;
		fileNotFound: string;
		// Error Handler specific
		titles: {
			apiKeyCheck: string;
			apiUsageLimit: string;
			apiConnection: string;
			fileError: string;
			fileAccessError: string;
			fileLoadError: string;
			networkError: string;
			audioProcessError: string;
			fileSizeError: string;
			unexpectedError: string;
		};
		messages: {
			apiKeyRecheck: string;
			apiUsageLimitReached: string;
			apiConnectionIssue: string;
			apiConnectionFailedDetailed: string;
			fileNotFound: string;
			fileAccessDenied: string;
			fileLoadFailed: string;
			networkConnectionIssue: string;
			audioProcessFailed: string;
			fileSizeExceeded: string;
			diskSpaceLow: string;
			unexpectedErrorOccurred: string;
			noAudioTrack: string;
			unsupportedVideoCodec: string;
			noTranscriptionText: string;
			invalidTimeRange: string;
			endTimeExceedsDuration: string;
			unableToOpenFile: string;
			fileInsertionFailed: string;
		};
		recoveryActions: {
			openSettings: string;
			connectionTest: string;
			checkSupportedFormats: string;
			retry: string;
			tryOtherFormat: string;
			checkSizeLimit: string;
			enableDebugMode: string;
		};
		notices: {
			settingsCheck: string;
			settingsConnectionTest: string;
			supportedFormats: string;
			networkRetry: string;
			formatConversion: string;
			sizeLimit: string;
			debugModeEnable: string;
		};
	};

	// Units
	units: {
		seconds: string;
		minutes: string;
		hours: string;
		mb: string;
		gb: string;
	};

	// Audio Range Selection
	audioRange: {
		title: string;
		description: string;
		audioDuration: string;
		enableSelection: string;
		startTime: string;
		endTime: string;
	};

	// Common
	common: {
		noHistory: string;
		noActiveTask: string;
		loading: string;
		idle: string;
		processing: string;
		completed: string;
		partial: string;
		failed: string;
		cancelled: string;
		retry: string;
		close: string;
		save: string;
		cancel: string;
		delete: string;
		confirm: string;
		yes: string;
		no: string;
		ok: string;
		error: string;
		warning: string;
		info: string;
		success: string;
		history: string;
		progressStatus: string;
		elapsedTime: string;
		searchForFile: string;
		search: string;
		manualSearchRequired: string;
		multipleAudioFilesFound: string;
		historyUpdated: string;
		selectFile: string;
		multipleFilesFound: string;
		fileSize: {
			zero: string;
			units: {
				bytes: string;
				kb: string;
				mb: string;
				gb: string;
			};
		};
	};

	// Support section
	support: {
		message: string;
		imageAlt: string;
	};
}

export type SupportedLocale = 'en' | 'ja' | 'zh' | 'ko';

export const SUPPORTED_LOCALES: Record<SupportedLocale, string> = {
	en: 'English',
	ja: '日本語',
	zh: '中文',
	ko: '한국어'
};
