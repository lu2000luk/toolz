// Recording Manager - handles recording user actions

import type {
	RecordedAction,
	RecordingFile,
	ActionHeader,
} from "./recordingTypes";
import { DEFAULT_HEADER, serializeRlsActions } from "./recordingTypes";

export class RecordingManager {
	private isRecording: boolean = false;
	private actions: RecordedAction[] = [];
	private header: ActionHeader = { ...DEFAULT_HEADER };

	// Start recording
	start() {
		this.isRecording = true;
		this.actions = [];
		this.header = { ...DEFAULT_HEADER };
	}

	// Stop recording
	stop(): RecordingFile {
		this.isRecording = false;
		return {
			header: this.header,
			actions: this.actions,
		};
	}

	// Check if currently recording
	get recording(): boolean {
		return this.isRecording;
	}

	// Get current action count
	get actionCount(): number {
		return this.actions.length;
	}

	// Update header settings
	updateHeader(updates: Partial<ActionHeader>) {
		this.header = { ...this.header, ...updates };
	}

	// Get current header
	getHeader(): ActionHeader {
		return { ...this.header };
	}

	// Record an edit action
	recordEdit(key: string, value: any) {
		if (!this.isRecording) return;
		this.actions.push({ type: "edit", key, value });
	}

	// Record a delete action
	recordDelete(key: string) {
		if (!this.isRecording) return;
		this.actions.push({ type: "delete", key });
	}

	// Record a get action
	recordGet(key: string) {
		if (!this.isRecording) return;
		this.actions.push({ type: "get", key });
	}

	// Add a manual sleep action (for export only, not recorded from user input)
	addSleep(timeMs: number) {
		if (!this.isRecording) return;
		this.actions.push({ type: "sleep", timeMs });
	}

	// Export to file content string
	export(): string {
		return serializeRlsActions({
			header: this.header,
			actions: this.actions,
		});
	}

	// Clear all recorded actions
	clear() {
		this.actions = [];
	}
}

// Singleton instance
export const recordingManager = new RecordingManager();
