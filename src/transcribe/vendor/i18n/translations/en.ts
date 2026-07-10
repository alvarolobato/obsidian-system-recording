/**
 * English translations
 */

import type { TranslationKeys } from '../locales';

const en: TranslationKeys = {
	// Plugin info
	plugin: {
		name: 'AI transcriber' // Not translated
	},

	// Settings
	settings: {
		title: 'AI transcriber settings',
		apiKey: {
			name: 'OpenAI API key',
			desc: 'Your OpenAI API key',
			placeholder: 'Enter your OpenAI API key',
			testButton: 'Test connection',
			testSuccess: 'Connection successful',
			testFailed: 'Connection failed. Please check your API key.',
			insecureWarning: 'Operating system encryption not available; using the fallback encryption method.',
			migrated: 'API key has been automatically migrated to the new encryption format.'
		},
		model: {
			name: 'Default transcription model',
			desc: 'Choose the AI model for transcription',
			comparison: 'Model comparison:',
			whisper: 'Whisper-1',
			whisperDesc: 'Supports timestamped output',
			gpt4o: 'GPT-4o transcribe',
			gpt4oDesc: 'High accuracy',
			gpt4oMini: 'GPT-4o mini transcribe',
			gpt4oMiniDesc: 'Low cost',
			whisperNoTimestamp: 'Whisper-1 (no timestamps)',
			whisperWithTimestamp: 'Whisper-1 (with timestamps)',
			gpt4oHigh: 'GPT-4o transcribe',
			gpt4oMiniCost: 'GPT-4o mini transcribe'
		},
		vadMode: {
			name: 'Silence detection (voice activity detection)',
			desc: 'Processing silent segments can lighten speech recognition workload and reduce the amount of data sent',
			options: {
				server: 'Server',
				local: 'Local',
				disabled: 'Off'
			},
			summaries: {
				server: 'Standard: faster processing',
				local: 'Advanced: faster, less data sent',
				disabled: 'No silence processing'
			},
			missingWarning: "Using local voice activity detection requires a third-party module; download 'fvad.wasm' from the fvad-wasm repository, then click the choose file button to copy it into the plugin folder.",
			missingInlineNote: "Using local voice activity detection requires a third-party module; download 'fvad.wasm' from the fvad-wasm repository, then click the choose file button to copy it into the plugin folder.",
			localNote: 'Since silent segments are removed on-device before sending, it helps reduce API costs.',
			installWasm: {
				name: 'Place fvad.wasm',
				desc: 'Select an existing fvad.wasm to automatically place it into the plugin folder',
				button: 'Choose file',
				success: 'Placed fvad.wasm successfully',
				invalidName: 'Please select fvad.wasm',
				invalidType: 'Not a valid WebAssembly file',
				writeError: 'Failed to place file: {error}'
			}
		},
		language: {
			name: 'Language',
			desc: 'Primary language for transcription',
			autoDetect: 'Auto-detect',
			useObsidianLang: 'Use Obsidian language',
			options: {
				ja: 'Japanese',
				en: 'English',
				zh: 'Chinese',
				ko: 'Korean'
			}
		},
		outputFormat: {
			name: 'Output format',
			desc: 'How to format the transcription output',
			callout: 'Callout block',
			quote: 'Quote block',
			plain: 'Plain text'
		},
		postProcessing: {
			name: 'Enable post-processing',
			desc: 'Use AI to enhance transcription with related information after completion'
		},
		dictionaryCorrection: {
			name: 'Enable dictionary correction',
			desc: 'Automatically correct transcription results using dictionary-based text correction'
		},
		outputFolder: {
			name: 'Output folder',
			desc: 'Folder to save transcription results (empty for vault root)',
			placeholder: 'E.g., transcriptions',
			select: 'Select folder'
		},
		advanced: {
			title: 'Advanced settings',
			chunkInfo: 'Chunk settings guide:',
				chunk180s: 'Recommended setting: 180 seconds (3 minutes), avoids timeouts',
				chunk300s: 'Default setting: 300 seconds (5 minutes), balanced performance',
				chunk600s: 'Maximum setting: 600 seconds (10 minutes), may cause timeouts',
			chunkNote: 'Note: smaller chunks are more reliable but may increase API calls'
		},
		progressUI: {
			title: 'Progress UI settings',
			statusBar: 'Show status bar',
			statusBarDesc: 'Display transcription progress in the status bar',
			autoOpen: 'Auto-open side panel',
			autoOpenDesc: 'Automatically open the side panel when transcription starts',
			maxHistory: 'Maximum history items',
			maxHistoryDesc: 'Number of transcription history items to keep (10-100)'
		},
		debug: {
			mode: 'Debug mode',
			modeDesc: 'Output detailed console logs (for developers)'
		},
		dictionary: {
			name: 'User dictionary',
			desc: 'Edit the dictionary to correct speech recognition errors',
			addButton: 'Add entry',
			deleteButton: 'Delete',
			from: 'From',
			to: 'To',
			enabled: 'Enabled',
			category: 'Category',
			priority: 'Priority',
			context: 'Context',
			definiteCorrections: 'Definite corrections',
			contextualCorrections: 'Contextual corrections',
			importExport: 'Import/export',
			importExportDesc: 'Import or export dictionary data in JSON format',
			import: 'Import',
			export: 'Export',
			importSuccess: 'Dictionary imported successfully',
			exportSuccess: 'Dictionary exported successfully',
			importError: 'Import error: ',
			noDataToExport: 'No data to export',
			exportError: 'Export failed',
			importConfirm: 'What would you like to do with existing dictionary data?',
			replace: 'Replace',
			merge: 'Merge',
			manageDictionary: 'Dictionary management',
			manageDictionaryDesc: 'Edit and manage user dictionary',
			openManager: 'Manage dictionary',
			title: 'User dictionary management',
			fromPlaceholder: 'From (comma-separated)',
			toPlaceholder: 'To',
				autoModeDesc: 'All language dictionaries will be applied in auto-detect mode. Note: definite corrections are applied as automatic replacements; contextual corrections apply only when their keywords are present.',
				languageModeDesc: 'Only the {lang} dictionary will be applied. Note: definite corrections are applied as automatic replacements; contextual corrections apply only when their keywords are present.',
			contextPlaceholder: 'Keywords (comma-separated)',
			limitReached: 'Dictionary limit reached ({limit} entries)',
			categories: {
				noun: 'Noun',
				person: 'Person',
				place: 'Place',
				org: 'Organization',
				proper: 'Proper noun',
				technical: 'Technical term',
				spoken: 'Spoken language',
				symbol: 'Symbol/unit'
			}
		},
		connection: {
			title: 'Connection test',
			name: 'Test API connection',
			desc: 'Verify your API key and connection',
			testButton: 'Test connection',
			testing: 'Testing...',
			successNotice: '{provider} connection successful ✅!',
			successButton: 'Connected ✅',
			failureNotice: '{provider} connection failed ❌. Check your API key.',
			failureButton: 'Failed ❌',
			errorNotice: 'Connection test failed ❌: {error}',
			errorButton: 'Error ❌',
			clearTitle: 'Clear API keys',
			clearDesc: 'Remove all stored API keys (useful for troubleshooting)',
			clearButton: 'Clear all keys',
			clearedNotice: 'API key cleared'
		}
	},

	// Provider names
	providers: {
		openai: 'OpenAI',
		whisper: 'OpenAI whisper',
		whisperTs: 'OpenAI whisper (with timestamps)',
		gpt4o: 'GPT-4o transcribe',
		gpt4oMini: 'GPT-4o mini transcribe'
	},

	// Commands
	commands: {
		transcribeAudio: 'Transcribe audio file (API)',
		openPanel: 'Open transcription panel',
		contextMenu: 'Transcribe with AI'
	},

	// Ribbon
	ribbon: {
		tooltip: 'AI transcriber'
	},

	// Status bar
	statusBar: {
		processing: 'Transcribing',
		completed: 'Transcription completed',
		failed: 'Transcription failed',
		cancelled: 'Transcription cancelled',
		clickToOpen: 'Click to view details'
	},

	// Notices
	notices: {
		apiKeyNotConfigured: 'API key not configured. Please add your OpenAI API key in settings.',
		apiKeyMissing: 'API key not configured. Please add your OpenAI API key in settings.',
		transcriptionComplete: 'Transcription completed successfully',
		transcriptionFailed: 'Transcription failed. Please try again.',
		transcriptionCancelled: 'Transcription cancelled',
		noAudioFile: 'No audio file selected',
		processingFile: 'Processing file: {fileName}',
		vadInitError: 'Voice activity detection initialization error: fvad.wasm file not found. Please place it in the plugin folder.',
		vadServerFallback: 'Local voice activity detection module not found. Falling back to server-side processing.',
		vadProcessingError: 'Voice activity detection processing error: {error}',
		vadUnavailable: 'Voice activity detection is unavailable, proceeding without silence removal.',
		externalFileNotSupported: 'External file processing will be implemented in the next phase',
		postProcessingComplete: 'Post-processing completed: {model} was used',
		postProcessingFailed: 'Post-processing failed. Using original transcription.',
		languageSet: 'Language set to: {language}',
		settingsSaved: 'Settings saved',
		largeFileWarning: 'Processing large file ({size} MB) may take time',
		unsupportedFormat: 'Unsupported audio format: {format}',
		legacyHistoryItem: 'Legacy history item - file path not recorded',
		backgroundProcessingStarted: 'Background transcription started. Check the status bar for progress.',
		backgroundProcessingError: 'Background processing error: {message}',
		partialTranscriptionComplete: 'Partial transcription completed: generated {count} characters (some errors).',
		transcriptionCompleteDetailed: 'Transcription completed: generated {count} characters{details}',
		postProcessingSuffix: ' (post-processing: {model})',
		transcriptionAppendedFallback: 'Transcription appended to the end of the file due to an insertion error.',
		transcriptionSavedToNewFile: 'Transcription saved to new file: {fileName}',
		transcriptionManualRecovery: 'Failed to save transcription. A recovery window shows the generated content.'
	},

	// Transcription Modal
	modal: {
		// Common modal buttons
		button: {
			ok: 'OK',
			cancel: 'Cancel'
		},
		audioFileSelection: {
			title: 'Select audio file',
			searchPlaceholder: 'Search by filename...',
			sortBy: 'Sort by:',
			sortByCreated: 'Date created',
			sortByModified: 'Date modified',
			sortByDate: 'Date modified',
			sortByName: 'Name',
			sortByPath: 'Path',
			fileName: 'File name',
			fileCreated: 'Date created',
			filePath: 'Path',
			noFiles: 'No audio files found',
			selectExternal: 'Select from outside vault',
			copying: 'Copying file...',
			externalFileNotice: 'When selecting files from outside the vault, they will be temporarily copied to a folder within the vault due to Obsidian restrictions.\nCopied files will be deleted on the next startup.'
		},
		transcription: {
			title: 'AI transcriber',
			fileInfo: 'File information',
			modelLabel: 'Transcription AI model',
			fileSize: 'Size: {size}',
			fileType: 'File type: {type}',
			audioFile: 'Audio file',
			videoFile: 'Video file',
			extractingAudio: 'Extracting audio from video',
			largeFileWarning: 'Processing large file ({size} MB) may take time',
			costEstimate: 'Estimated cost',
			costNote: 'Actual cost may vary based on processing',
			costDetails: 'Model: {model} • Rate: {rate}',
			additionalProcessingCostNote: 'This amount covers transcription only. AI post-processing or user dictionary correction can add API usage and may exceed the estimate.',
			timeRange: 'Time range',
			selectTimeRange: 'Select specific time range (optional)',
			startTime: 'Start',
			endTime: 'End',
			duration: 'Duration: {duration}',
			metaInfoButton: 'Add related info',
			metaInfoButtonFilled: 'Related info added',
			processingOptions: {
				title: 'Processing options',
				enablePostProcessing: 'Enable AI post-processing',
				enablePostProcessingDesc: 'Uses an additional API request, so the final cost may exceed the estimate above.',
				enableDictionaryCorrection: 'Use user dictionary in post-processing',
				enableDictionaryCorrectionDesc: 'Dictionary correction can also add API usage.',
				outputFolder: 'Output folder',
				relatedInfo: 'Related information'
			},
			startButton: 'Start transcription',
			cancelButton: 'Cancel',
			processing: 'Processing',
			preparingAudio: 'Preparing audio',
			transcribing: 'Transcribing',
			postProcessing: 'Post-processing with AI',
			postProcessingCompleted: 'Post-processing completed',
			savingResults: 'Saving results',
			completed: 'Completed',
			partialResult: 'Partial transcription result',
			partialSummary: '{processed}/{total} chunks processed.',
			partialCancelled: 'Transcription cancelled. Completed {processed} out of {total} chunks.',
			partialError: 'Partial transcription due to error: {error}. Completed {processed} out of {total} chunks.',
			partialNoChunks: 'Transcription was cancelled before any chunks were processed.',
			partialFailedChunks: 'Some chunks ({chunks}) failed.',
			chunkFailure: 'Chunk {index} failed: {error}',
			chunkFailureSummary: 'Chunk {id}: {error}',
			costEstimateSummary: 'Approximately {minutes} minutes @ {rate}/min',
			manualRecoveryTitle: 'Recover transcription',
			manualRecoveryDescription: 'The plugin could not save the generated note. Use the text below to restore the transcription manually.',
			manualRecoveryTarget: 'Target file: {path}',
			manualRecoveryError: 'Save error: {error}',
			manualRecoverySelectText: 'Select text'
		},
		postProcessing: {
			titlePre: 'Pre-transcription related information',
			titlePost: 'Post-transcription processing',
			transcriptionPreview: 'Transcription preview',
			relatedInfo: 'Related information',
			metaInfoPlaceholder: 'Examples: speaker names, topics (artificial intelligence, machine learning), technical terms (neural networks, deep learning), context (meeting, interview), or any other information related to the audio content',
			metaInfoDescription: 'Enter any information about the audio content or speakers. This information will be used by AI for more accurate transcription and post-processing.',
			emptyInputError: 'Please enter related information.',
			templateOnlyError: 'Please enter actual information based on the template examples.',
			options: 'Options',
			enablePostProcessing: 'Use related information for post-processing',
			processButton: 'Process',
			cancelButton: 'Cancel',
			processing: 'Processing'
		}
	},

	// Errors
	errors: {
		general: 'An error occurred',
		audioLoad: 'Failed to load audio file',
		audioProcess: 'Failed to process audio',
		apiError: 'API error: {error}',
		networkError: 'Network error. Please check your connection.',
		timeout: 'Request timed out',
		cancelled: 'Operation cancelled',
		invalidResponse: 'Invalid response from server',
		vadInitFailed: 'VAD initialization failed: {error}',
		vadProcessFailed: 'VAD processing failed: {error}',
		apiKeyMissing: 'API key is missing',
		invalidApiKeyFormat: 'Invalid API key format. Key should start with "sk-"',
		invalidApiKey: 'Invalid API key',
		rateLimitExceeded: 'Rate limit exceeded. Please try again later',
		apiUnavailable: 'OpenAI API is temporarily unavailable',
		apiConnectionFailed: 'API connection failed (Status: {status})',
		chunkingFailed: 'Audio chunking failed',
		mergingFailed: 'Failed to merge transcription chunks',
		saveFailed: 'Failed to save transcription',
		createFileFailed: 'Failed to create transcription file: {error}',
		validationFailed: 'Validation failed: {details}',
		transcriptionCancelledByUser: 'Transcription cancelled by user',
		unsupportedAudioFormat: 'Unsupported audio format: {extension}. Supported formats: {formats}',
		audioValidationFailed: 'Audio validation failed: {error}',
		noTranscriptionResults: 'No transcription results obtained',
		costEstimateUnavailable: 'Unable to estimate cost',
		settingsLoad: 'Failed to load settings',
		settingsSave: 'Failed to save settings',
		fileNotFound: 'Transcription file not found',
		// Error Handler specific
		titles: {
			apiKeyCheck: 'API key check',
			apiUsageLimit: 'API usage limit',
			apiConnection: 'API connection',
			fileError: 'File error',
			fileAccessError: 'File access error',
			fileLoadError: 'File load error',
			networkError: 'Network error',
			audioProcessError: 'Audio processing error',
			fileSizeError: 'File size error',
			unexpectedError: 'Unexpected error'
		},
		messages: {
			apiKeyRecheck: 'Please check your API key again.',
			apiUsageLimitReached: 'API usage limit reached. Please wait before retrying.',
			apiConnectionIssue: 'There seems to be a connection issue. Please check your API key.',
			apiConnectionFailedDetailed: 'API connection failed. Please check your API key and internet connection.',
			fileNotFound: 'Audio file not found. Please check if the file has been moved or deleted.',
			fileAccessDenied: 'Cannot access the file. Please check file permissions.',
			fileLoadFailed: 'Failed to load audio file. Please check the file format (mp3, wav, m4a, etc.).',
			networkConnectionIssue: 'Please check your internet connection and retry when stable.',
			audioProcessFailed: 'Audio file processing failed. Please check if the file is corrupted or in a supported format.',
			fileSizeExceeded: 'File size exceeds the limit (500 megabytes max).',
			diskSpaceLow: 'Insufficient available space (remaining: {available}GB).',
			unexpectedErrorOccurred: 'An error occurred during processing. Please wait and try again.',
			noAudioTrack: 'The video file does not contain an audio track.',
			unsupportedVideoCodec: 'Unsupported video codec. Please convert to a different format.',
			noTranscriptionText: 'No transcription text was generated. Please check audio quality and try again.',
			invalidTimeRange: 'Start time must be earlier than end time.',
			endTimeExceedsDuration: 'End time ({end}) exceeds audio duration ({duration}).',
			unableToOpenFile: 'Unable to open the created file.',
			fileInsertionFailed: 'File insertion failed. The recovery window shows the transcription text.'
		},
		recoveryActions: {
			openSettings: 'Open settings',
			connectionTest: 'Connection test',
			checkSupportedFormats: 'Check supported formats',
			retry: 'Retry',
			tryOtherFormat: 'Try other format',
			checkSizeLimit: 'Check size limit',
			enableDebugMode: 'Enable debug mode'
		},
		notices: {
			settingsCheck: 'Please check your API key in settings',
			settingsConnectionTest: 'Please try the test connection button in settings.',
			supportedFormats: 'Supported formats include audio (mp3, wav, m4a, flac, aac, ogg) and video (mp4, m4v, mov, avi, mkv, webm).',
			networkRetry: 'Please check network connection and try again',
			formatConversion: 'Please convert to wav or mp3 format and try again.',
			sizeLimit: 'The advanced option supports 20 megabytes per 25 minutes, and the whisper option supports 20 megabytes.',
			debugModeEnable: 'Enable debug mode in settings to view detailed logs'
		}
	},

	// Units
	units: {
		seconds: 'Seconds',
		minutes: 'Minutes',
		hours: 'Hours',
		mb: 'MB',
		gb: 'GB'
	},

	// Audio Range Selection
	audioRange: {
		title: 'Audio range selection',
		description: 'Select specific time range to reduce hallucinations and processing time',
		audioDuration: 'Audio duration',
		enableSelection: 'Enable time range selection',
		startTime: 'Start',
		endTime: 'End'
	},

	// Common
	common: {
		noHistory: 'No transcription history',
		noActiveTask: 'No active transcription tasks',
		loading: 'Loading',
		idle: 'Idle',
		processing: 'Processing',
		completed: 'Completed',
		partial: 'Partial',
		failed: 'Failed',
		cancelled: 'Cancelled',
		retry: 'Retry',
		close: 'Close',
		save: 'Save',
		cancel: 'Cancel',
		delete: 'Delete',
		confirm: 'Confirm',
		yes: 'Yes',
		no: 'No',
		ok: 'OK',
		error: 'Error',
		warning: 'Warning',
		info: 'Info',
		success: 'Success',
		history: 'Transcription history',
		progressStatus: 'Progress status',
		elapsedTime: 'Elapsed time',
		searchForFile: 'Search for file with transcription timestamp "{timestamp}"?',
		search: 'Search',
		manualSearchRequired: 'Not found automatically. Please search manually.',
		multipleAudioFilesFound: 'Multiple audio files found',
		historyUpdated: 'History updated',
		selectFile: 'Select file',
		multipleFilesFound: 'Multiple files found. Please select:',
		fileSize: {
			zero: 'Zero bytes',
			units: {
				bytes: 'Bytes',
				kb: 'KB',
				mb: 'MB',
				gb: 'GB'
			}
		}
	},

	// Support section
	support: {
		message: 'If this plugin adds value for you and you would like to help support continued development, please use the buttons below:',
		imageAlt: 'Support AI transcriber via the buy me a coffee link.'
	}

};

export default en;
