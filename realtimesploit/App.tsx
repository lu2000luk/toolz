import React, { useState, useEffect, useCallback } from "react";
import { Box, Text } from "ink";
import CredentialsForm from "./CredentialsForm";
import Explorer from "./Explorer";
import PlaybackMode from "./PlaybackMode";
import type { FirebaseConfig } from "./types";
import type { RecordingFile } from "./recordingTypes";
import { parseRlsActionsFile } from "./recordingTypes";
import { initializeApp } from "firebase/app";
import { getDatabase, Database } from "firebase/database";
import { readFile } from "fs/promises";
import { resolve } from "path";

type AppMode = "EXPLORER" | "PLAYBACK";

export default function App() {
	const [db, setDb] = useState<Database | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingConfig, setLoadingConfig] = useState(true);
	const [appMode, setAppMode] = useState<AppMode>("EXPLORER");
	const [recording, setRecording] = useState<RecordingFile | null>(null);
	const [playbackError, setPlaybackError] = useState<string | null>(null);

	const handleCredentialsSubmit = (creds: FirebaseConfig) => {
		try {
			// Basic validation
			if (!creds.databaseURL) {
				setError("Database URL is required.");
				return;
			}

			// Attempt to initialize
			const app = initializeApp(creds, "APP_" + Date.now());
			const database = getDatabase(app);
			setDb(database);
			setError(null);
		} catch (e: any) {
			setError(e.message || "Failed to initialize Firebase");
		}
	};

	const handleStartPlayback = useCallback(async (filePath: string) => {
		try {
			setPlaybackError(null);
			const content = await readFile(filePath, "utf-8");
			const parsed = parseRlsActionsFile(content);
			setRecording(parsed);
			setAppMode("PLAYBACK");
		} catch (e: any) {
			setPlaybackError(`Failed to load recording: ${e.message}`);
		}
	}, []);

	const handleExitPlayback = useCallback(() => {
		setRecording(null);
		setAppMode("EXPLORER");
	}, []);

	useEffect(() => {
		const loadConfig = async () => {
			try {
				const p = resolve(process.cwd(), "firebase.json");
				const content = await readFile(p, "utf-8");
				const json = JSON.parse(content);
				// Simple check for required fields, others are optional
				if (json.databaseURL) {
					handleCredentialsSubmit(json as FirebaseConfig);
				}
			} catch (e) {
				// File not found or invalid, ignore
			} finally {
				setLoadingConfig(false);
			}
		};
		loadConfig();
	}, []);

	if (loadingConfig) {
		return <Text color="green">Loading configuration...</Text>;
	}

	if (!db) {
		return (
			<Box flexDirection="column">
				{error && (
					<Text color="red" bold>
						Error: {error}
					</Text>
				)}
				<CredentialsForm onSubmit={handleCredentialsSubmit} />
			</Box>
		);
	}

	if (appMode === "PLAYBACK" && recording) {
		return (
			<PlaybackMode db={db} recording={recording} onExit={handleExitPlayback} />
		);
	}

	return (
		<Box flexDirection="column">
			{playbackError && (
				<Box marginBottom={1}>
					<Text color="red">{playbackError}</Text>
				</Box>
			)}
			<Explorer db={db} onStartPlayback={handleStartPlayback} />
		</Box>
	);
}
