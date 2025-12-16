import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { Database, ref, get, set } from "firebase/database";
import type { RecordingFile, RecordedAction } from "./recordingTypes";

interface PlaybackProps {
	db: Database;
	recording: RecordingFile;
	onExit: () => void;
}

type PlaybackState =
	| "PAUSED"
	| "RUNNING"
	| "WAITING_CONFIRM"
	| "COMPLETED"
	| "STOPPED";

export default function PlaybackMode({ db, recording, onExit }: PlaybackProps) {
	const [state, setState] = useState<PlaybackState>("PAUSED");
	const [currentIndex, setCurrentIndex] = useState(0);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [loopCount, setLoopCount] = useState(0);
	const [lastActionResult, setLastActionResult] = useState<string | null>(null);

	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	const isRunningRef = useRef(false);

	const { header, actions } = recording;
	const totalActions = actions.length;

	const currentAction = actions[currentIndex];
	const previousAction = currentIndex > 0 ? actions[currentIndex - 1] : null;
	const nextAction =
		currentIndex < totalActions - 1 ? actions[currentIndex + 1] : null;

	// Format action for display
	const formatAction = useCallback(
		(action: RecordedAction | null | undefined, index?: number): string => {
			if (!action) return "—";
			const prefix = index !== undefined ? `[${index + 1}] ` : "";
			switch (action.type) {
				case "sleep":
					return `${prefix}SLEEP ${action.timeMs}ms`;
				case "edit":
					return `${prefix}EDIT ${action.key} → ${JSON.stringify(
						action.value
					).substring(0, 30)}`;
				case "delete":
					return `${prefix}DELETE ${action.key}`;
				case "get":
					return `${prefix}GET ${action.key}`;
			}
		},
		[]
	);

	// Execute a single action
	const executeAction = useCallback(
		async (action: RecordedAction): Promise<string> => {
			switch (action.type) {
				case "sleep":
					await new Promise((resolve) => setTimeout(resolve, action.timeMs));
					return `Slept for ${action.timeMs}ms`;

				case "edit": {
					const editRef = ref(db, action.key);
					await set(editRef, action.value);
					return `Edited ${action.key}`;
				}

				case "delete": {
					const deleteRef = ref(db, action.key);
					await set(deleteRef, null);
					return `Deleted ${action.key}`;
				}

				case "get": {
					const getRef = ref(db, action.key);
					const snapshot = await get(getRef);
					const val = snapshot.exists() ? snapshot.val() : null;
					return `Got ${action.key}: ${JSON.stringify(val).substring(0, 50)}`;
				}
			}
		},
		[db]
	);

	// Check if action requires confirmation
	const needsConfirmation = useCallback(
		(action: RecordedAction): boolean => {
			if (!header.confirmActions) return false;
			return action.type === "edit" || action.type === "delete";
		},
		[header.confirmActions]
	);

	// Process next action
	const processNextAction = useCallback(async () => {
		if (!isRunningRef.current) return;
		if (currentIndex >= totalActions) {
			if (header.playMode === "loop") {
				setLoopCount((c) => c + 1);
				setCurrentIndex(0);
				setStatusMessage("Looping...");
			} else {
				setState("COMPLETED");
				setStatusMessage("Playback completed!");
			}
			return;
		}

		const action = actions[currentIndex];
		if (!action) return;

		// Check if confirmation is needed
		if (needsConfirmation(action)) {
			setState("WAITING_CONFIRM");
			setStatusMessage(`Confirm ${action.type.toUpperCase()} action? (y/n)`);
			return;
		}

		// Execute the action
		setState("RUNNING");
		setStatusMessage(`Executing: ${formatAction(action)}`);

		try {
			const result = await executeAction(action);
			setLastActionResult(result);

			// Auto sleep after action
			if (header.autoSleepMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, header.autoSleepMs));
			}

			setCurrentIndex((i) => i + 1);
		} catch (e: any) {
			setStatusMessage(`Error: ${e.message}`);
			setState("PAUSED");
			isRunningRef.current = false;
		}
	}, [
		currentIndex,
		totalActions,
		actions,
		header,
		executeAction,
		needsConfirmation,
		formatAction,
	]);

	// Start/resume playback
	const startPlayback = useCallback(() => {
		isRunningRef.current = true;
		setState("RUNNING");
		setStatusMessage("Running...");
	}, []);

	// Pause playback
	const pausePlayback = useCallback(() => {
		isRunningRef.current = false;
		setState("PAUSED");
		setStatusMessage("Paused - Press SPACE to resume");
	}, []);

	// Stop playback
	const stopPlayback = useCallback(() => {
		isRunningRef.current = false;
		setState("STOPPED");
		setStatusMessage("Stopped.");
	}, []);

	// Effect for running actions
	useEffect(() => {
		if (state === "RUNNING" && isRunningRef.current) {
			processNextAction();
		}
	}, [state, currentIndex, processNextAction]);

	// Timeout handling
	useEffect(() => {
		if (state === "RUNNING" || state === "WAITING_CONFIRM") {
			timeoutRef.current = setTimeout(() => {
				setStatusMessage("Timeout reached!");
				stopPlayback();
			}, header.timeoutSeconds * 1000);
		}

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [state, header.timeoutSeconds, stopPlayback]);

	// Input handling
	useInput((input, key) => {
		if (state === "COMPLETED" || state === "STOPPED") {
			if (key.escape || input === "q") {
				onExit();
			}
			if (input === "r") {
				// Restart
				setCurrentIndex(0);
				setLoopCount(0);
				setState("PAUSED");
				setStatusMessage("Reset. Press SPACE to start.");
			}
			return;
		}

		if (state === "WAITING_CONFIRM") {
			if (input === "y" || key.return) {
				// Confirm and execute
				const action = actions[currentIndex];
				if (action) {
					setState("RUNNING");
					setStatusMessage(`Executing: ${formatAction(action)}`);
					executeAction(action)
						.then((result) => {
							setLastActionResult(result);
							setCurrentIndex((i) => i + 1);
						})
						.catch((e) => {
							setStatusMessage(`Error: ${e.message}`);
							setState("PAUSED");
							isRunningRef.current = false;
						});
				}
			}
			if (input === "n" || key.escape) {
				// Skip this action
				setStatusMessage("Action skipped.");
				setCurrentIndex((i) => i + 1);
				setState("RUNNING");
			}
			return;
		}

		// Normal controls
		if (input === " ") {
			if (state === "PAUSED") {
				startPlayback();
			} else if (state === "RUNNING") {
				pausePlayback();
			}
		}

		if (key.escape || input === "q") {
			stopPlayback();
		}

		// Skip current action
		if (input === "s" && (state === "PAUSED" || state === "RUNNING")) {
			setCurrentIndex((i) => Math.min(i + 1, totalActions - 1));
			setStatusMessage("Skipped to next action.");
		}
	});

	// Color based on state
	const borderColor =
		state === "RUNNING"
			? "green"
			: state === "PAUSED"
			? "yellow"
			: state === "WAITING_CONFIRM"
			? "magenta"
			: state === "COMPLETED"
			? "cyan"
			: "red";

	return (
		<Box
			flexDirection="column"
			padding={1}
			borderStyle="round"
			borderColor={borderColor}
			width={100}
		>
			{/* Header Info */}
			<Box marginBottom={1} justifyContent="space-between">
				<Box>
					<Text bold color="cyan">
						PLAYBACK MODE
					</Text>
					<Text> | </Text>
					<Text color="yellow">{state}</Text>
				</Box>
				<Box>
					<Text color="gray">
						{currentIndex + 1}/{totalActions}
						{header.playMode === "loop" && ` | Loop #${loopCount + 1}`}
					</Text>
				</Box>
			</Box>

			{/* Header Settings */}
			<Box marginBottom={1} flexDirection="column">
				<Text color="gray">
					Mode: <Text color="white">{header.playMode}</Text> | Confirm:{" "}
					<Text color={header.confirmActions ? "green" : "red"}>
						{header.confirmActions ? "ON" : "OFF"}
					</Text>{" "}
					| AutoSleep: <Text color="white">{header.autoSleepMs}ms</Text> |
					Timeout: <Text color="white">{header.timeoutSeconds}s</Text>
				</Text>
			</Box>

			{/* Status */}
			{statusMessage && (
				<Box marginBottom={1}>
					{state === "RUNNING" && <Spinner type="dots" />}
					<Text color="yellow"> {statusMessage}</Text>
				</Box>
			)}

			{/* Last Action Result */}
			{lastActionResult && (
				<Box marginBottom={1}>
					<Text color="gray">Last: </Text>
					<Text color="green">{lastActionResult}</Text>
				</Box>
			)}

			{/* Action Display */}
			<Box
				flexDirection="column"
				borderStyle="single"
				borderColor="gray"
				padding={1}
				marginBottom={1}
			>
				{/* Previous Action */}
				<Box>
					<Text color="gray">PREV: </Text>
					<Text color="gray" dimColor>
						{formatAction(previousAction, currentIndex - 1)}
					</Text>
				</Box>

				{/* Current Action */}
				<Box>
					<Text bold color="white">
						▶ NOW:{" "}
					</Text>
					<Text bold color="cyan">
						{formatAction(currentAction, currentIndex)}
					</Text>
				</Box>

				{/* Next Action */}
				<Box>
					<Text color="gray">NEXT: </Text>
					<Text color="gray">{formatAction(nextAction, currentIndex + 1)}</Text>
				</Box>
			</Box>

			{/* Controls */}
			<Box>
				<Text color="gray">
					{state === "COMPLETED" || state === "STOPPED"
						? "Press 'r' to restart, 'q'/ESC to exit"
						: "SPACE: Play/Pause | S: Skip | Q/ESC: Stop"}
				</Text>
			</Box>
		</Box>
	);
}
