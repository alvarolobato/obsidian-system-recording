// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

type Listener<T> = (payload: T) => void;

/** Minimal typed pub/sub used to keep the agenda view in sync with plugin state. */
export class TypedEventBus<Events extends Record<string, unknown>> {
	private listeners: Partial<{
		[K in keyof Events]: Set<Listener<Events[K]>>;
	}> = {};

	on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
		let set = this.listeners[event];
		if (!set) {
			set = new Set();
			this.listeners[event] = set;
		}
		set.add(fn);
		return () => {
			set?.delete(fn);
		};
	}

	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		const set = this.listeners[event];
		if (!set) return;
		for (const fn of set) {
			try {
				fn(payload);
			} catch (e) {
				console.warn("[Meeting Copilot] event listener error", e);
			}
		}
	}

	clear(): void {
		this.listeners = {};
	}
}
