import { Notice } from "obsidian";

/**
 * Shows a persistent Notice (no auto-timeout) with a single action button.
 * Clicking the button runs `onClick` and dismisses the notice.
 */
export function actionNotice(message: string, buttonLabel: string, onClick: () => void): Notice {
	const frag = window.activeDocument.createDocumentFragment();
	const container = frag.createDiv();
	container.createSpan({ text: message });
	const btn = container.createEl("button", {
		text: buttonLabel,
		cls: ["mod-cta", "system-recording-notice-button"],
	});
	const notice = new Notice(frag, 0);
	btn.addEventListener("click", () => {
		onClick();
		notice.hide();
	});
	return notice;
}

/** One button in a multi-action notice. `cta` renders it as the primary button. */
export interface NoticeAction {
	label: string;
	onClick: () => void;
	cta?: boolean;
}

/**
 * Shows a persistent Notice (no auto-timeout) with several action buttons — e.g.
 * a meeting prompt offering "Join", "Record", and "Join & record". Any button
 * runs its handler and dismisses the notice. Buttons with no `label` are
 * skipped, so callers can omit an action (like "Join") by leaving it out.
 * `onDismiss` (if given) fires after any button hides the notice, so the caller
 * can drop its own reference (e.g. a bookkeeping map entry).
 */
export function multiActionNotice(
	message: string,
	actions: NoticeAction[],
	onDismiss?: () => void
): Notice {
	const frag = window.activeDocument.createDocumentFragment();
	const container = frag.createDiv();
	container.createSpan({ text: message });
	const buttons = container.createDiv({ cls: "system-recording-notice-actions" });
	const notice = new Notice(frag, 0);
	for (const action of actions) {
		if (!action.label) continue;
		const btn = buttons.createEl("button", {
			text: action.label,
			cls: action.cta
				? ["mod-cta", "system-recording-notice-button"]
				: ["system-recording-notice-button"],
		});
		btn.addEventListener("click", () => {
			action.onClick();
			notice.hide();
			onDismiss?.();
		});
	}
	return notice;
}
