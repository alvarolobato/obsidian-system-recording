export type TranscriptionModel = 'whisper-1' | 'whisper-1-ts' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';
export type VADMode = 'server' | 'local' | 'disabled';

// Dictionary category types
export type DictionaryCategory = 'noun' | 'person' | 'place' | 'org' | 'proper' | 'technical' | 'spoken' | 'symbol';

// Dictionary entry interface - for definite corrections
export interface DictionaryEntry {
	from: string[]; // Patterns to match (array of strings)
	to: string; // Replacement text
	category?: DictionaryCategory; // Category
	priority?: number; // Priority (1-5, higher is better)
}

// Contextual correction entry
export interface ContextualCorrection extends DictionaryEntry {
	contextKeywords?: string[]; // Apply only when these keywords are present
}

// User dictionary settings
export interface UserDictionary {
	definiteCorrections: DictionaryEntry[];
	contextualCorrections?: ContextualCorrection[];
}

// Language-specific dictionaries
export interface LanguageDictionaries {
	ja: UserDictionary;
	en: UserDictionary;
	zh: UserDictionary;
	ko: UserDictionary;
}


export interface APITranscriptionSettings {
	language: string;
	outputFormat: string;

	// API settings (unified for all models)
	openaiApiKey: string;
	model: TranscriptionModel;
	/** Preferred Voice Activity Detection mode */
	vadMode: VADMode;

	// Post-processing settings
	postProcessingEnabled: boolean; // Enable AI-powered post-processing
	postProcessingModel?: string; // Model for post-processing

	// Dictionary correction settings
	dictionaryCorrectionEnabled: boolean; // Enable dictionary-based text correction

	// Output settings
	transcriptionOutputFolder: string; // Folder path for transcription output

	// Language-specific dictionaries
	userDictionaries: LanguageDictionaries;

	// Debug settings (for developers only)
	debugMode: boolean; // Enable detailed console logging
}

export const DEFAULT_API_SETTINGS: APITranscriptionSettings = {
	language: 'auto', // Default to auto-detect for international usage
	outputFormat: 'callout',

	openaiApiKey: '',
	model: 'gpt-4o-transcribe', // Default to high-accuracy model
	vadMode: 'server',


	// Post-processing settings
	postProcessingEnabled: false, // Disabled by default

	// Dictionary correction settings
	dictionaryCorrectionEnabled: false, // Disabled by default

	// Output settings
	transcriptionOutputFolder: '', // Default to vault root
	// Language-specific dictionaries
	userDictionaries: {
		ja: {
			definiteCorrections: [],
			contextualCorrections: []
		},
		en: {
			definiteCorrections: [],
			contextualCorrections: []
		},
		zh: {
			definiteCorrections: [],
			contextualCorrections: []
		},
		ko: {
			definiteCorrections: [],
			contextualCorrections: []
		}
	},

	// Debug settings
	debugMode: false // Disabled for production release
};
