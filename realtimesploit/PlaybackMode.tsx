import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { Database, ref, get, set } from "firebase/database";
import type {
  RecordingFile,
  RecordedAction,
  ExecAction,
  EditAction,
  DeleteAction,
} from "./recordingTypes";

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

  // Local queue of actions to support dynamic expansion (exec)
  const [actionQueue, setActionQueue] = useState<RecordedAction[]>(
    recording.actions,
  );

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isRunningRef = useRef(false);

  const { header } = recording;
  const totalActions = actionQueue.length;

  const currentAction = actionQueue[currentIndex];
  const previousAction =
    currentIndex > 0 ? actionQueue[currentIndex - 1] : null;
  const nextAction =
    currentIndex < totalActions - 1 ? actionQueue[currentIndex + 1] : null;

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
            action.value,
          ).substring(0, 30)}`;
        case "delete":
          return `${prefix}DELETE ${action.key}`;
        case "get":
          return `${prefix}GET ${action.key}`;
        case "exec":
          return `${prefix}EXEC ${action.path}`;
      }
    },
    [],
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

        case "exec":
          // Exec should be expanded before execution, but if it reaches here (e.g. manual skip/force), treat as no-op or error
          return "Exec action should have been expanded.";
      }
    },
    [db],
  );

  // Expand Exec Action
  const expandExecAction = useCallback(
    async (action: ExecAction): Promise<(EditAction | DeleteAction)[]> => {
      const { path, targetBase64, actionBase64 } = action;
      const targetExpr = Buffer.from(targetBase64, "base64").toString();
      const actionExpr = Buffer.from(actionBase64, "base64").toString();

      const rootRef = ref(db, path);
      const snapshot = await get(rootRef);

      if (!snapshot.exists()) return [];

      const data = snapshot.val();
      if (typeof data !== "object" || data === null) return [];

      const generatedActions: (EditAction | DeleteAction)[] = [];

      for (const [key, fields] of Object.entries(data)) {
        let isTarget = false;
        try {
          // Target expression is just a condition that returns true/false
          const fn = new Function("fields", "key", `return (${targetExpr});`);
          isTarget = fn(fields, key);
        } catch (e) {
          // Ignore errors in target eval
        }

        if (isTarget) {
          try {
            // Action expression returns ["DELETE", key] or ["SET", key, data]
            const fn = new Function("fields", "key", actionExpr);
            const result = fn(fields, key);

            if (Array.isArray(result) && result.length >= 2) {
              const [operation, actionKey, actionData] = result;
              const fullKey = actionKey.startsWith("/")
                ? actionKey
                : `${path}/${actionKey}`;

              if (operation === "DELETE") {
                generatedActions.push({
                  type: "delete",
                  key: fullKey,
                });
              } else if (operation === "SET" && result.length >= 3) {
                generatedActions.push({
                  type: "edit",
                  key: fullKey,
                  value: actionData,
                });
              }
            }
          } catch (e) {
            console.error(`Error executing action on ${key}:`, e);
          }
        }
      }
      return generatedActions;
    },
    [db],
  );

  // Check if action requires confirmation
  const needsConfirmation = useCallback(
    (action: RecordedAction): boolean => {
      if (!header.confirmActions) return false;
      return action.type === "edit" || action.type === "delete";
    },
    [header.confirmActions],
  );

  // Process next action
  const processNextAction = useCallback(async () => {
    if (!isRunningRef.current) return;
    if (currentIndex >= totalActions) {
      if (header.playMode === "loop") {
        setLoopCount((c) => c + 1);
        setCurrentIndex(0);
        setActionQueue(recording.actions); // Reset queue for loop
        setStatusMessage("Looping...");
      } else {
        setState("COMPLETED");
        setStatusMessage("Playback completed!");
      }
      return;
    }

    const action = actionQueue[currentIndex];
    if (!action) return;

    // Handle EXEC expansion
    if (action.type === "exec") {
      setState("RUNNING");
      setStatusMessage(`Expanding EXEC on ${action.path}...`);
      try {
        const newActions = await expandExecAction(action);

        const newQueue = [...actionQueue];
        if (newActions.length > 0) {
          newQueue.splice(currentIndex, 1, ...newActions);
          setStatusMessage(`Exec expanded into ${newActions.length} actions.`);
        } else {
          newQueue.splice(currentIndex, 1); // Remove exec if no matches
          setStatusMessage(`Exec matched nothing.`);
        }
        setActionQueue(newQueue);
        // Do not increment currentIndex, so we process the first new action (or next action) immediately next tick
        return;
      } catch (e: any) {
        setStatusMessage(`Exec Error: ${e.message}`);
        setState("PAUSED");
        isRunningRef.current = false;
        return;
      }
    }

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
    actionQueue,
    header,
    executeAction,
    needsConfirmation,
    formatAction,
    expandExecAction,
    recording.actions,
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
  }, [state, currentIndex, processNextAction, actionQueue]);

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
        setActionQueue(recording.actions);
        setState("PAUSED");
        setStatusMessage("Reset. Press SPACE to start.");
      }
      return;
    }

    if (state === "WAITING_CONFIRM") {
      if (input === "y" || key.return) {
        // Confirm and execute
        const action = actionQueue[currentIndex];
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
