import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  Database,
  ref,
  get,
  set,
  update,
  onValue,
  off,
} from "firebase/database";
import { writeFile, readFile, unlink } from "fs/promises";
import { exec } from "child_process";
import { resolve } from "path";
import { inferNextId, inferSchema } from "./schemaUtils.ts";
import { calculateDiff, type DiffChange } from "./diffUtils.ts";
import { recordingManager } from "./RecordingManager.ts";
import type { PlayMode } from "./recordingTypes.ts";

interface ExplorerProps {
  db: Database;
  onStartPlayback?: (filePath: string) => void;
}

type ExplorerMode =
  | "BROWSE"
  | "ADD_ID"
  | "ADD_VALUE"
  | "EDIT_PRIMITIVE"
  | "DELETE_CONFIRM"
  | "DUMPING"
  | "EXTERNAL_EDIT_WAIT"
  | "DIFF_REVIEW"
  | "DIFF_APPLY_CONFIRM"
  | "LOADING"
  | "RECORDING_CONFIG"
  | "EXPORT_RECORDING"
  | "LOAD_RECORDING"
  | "EVENTS"
  | "EVENT_EDIT_VALUE";

export default function Explorer({ db, onStartPlayback }: ExplorerProps) {
  // Navigation & Data
  const [path, setPath] = useState<string>("/");
  const [data, setData] = useState<any>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Mode Management
  const [mode, setMode] = useState<ExplorerMode>("LOADING");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Operation Specific State
  // Adding
  const [addId, setAddId] = useState("");
  const [addValue, setAddValue] = useState("");
  const [availableSchemas, setAvailableSchemas] = useState<any[]>([]);
  const [currentSchemaIndex, setCurrentSchemaIndex] = useState(0);

  // Editing Primitive
  const [editValue, setEditValue] = useState("");

  // Deleting
  const [itemToDelete, setItemToDelete] = useState<string | null>(null);

  // External Edit
  const [tempFilePath, setTempFilePath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<DiffChange[]>([]);
  const [diffCursor, setDiffCursor] = useState(0);

  // Selection
  const [highlightedItem, setHighlightedItem] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Realtime & Events
  const [events, setEvents] = useState<DiffChange[]>([]);
  const [eventCursor, setEventCursor] = useState(0);
  const [eventScrollOffset, setEventScrollOffset] = useState(0);
  const [conflictDetected, setConflictDetected] = useState(false);
  const initialEditValue = useRef<any>(null);
  const [targetPath, setTargetPath] = useState<string | null>(null);

  // Preferred preview field per parent path (e.g., "/users" -> "name")
  const [preferredPreviewFields, setPreferredPreviewFields] = useState<
    Record<string, string>
  >({});

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [exportFileName, setExportFileName] = useState("");
  const [loadFilePath, setLoadFilePath] = useState("");
  const [recordingPlayMode, setRecordingPlayMode] =
    useState<PlayMode>("normal");
  const [recordingConfirm, setRecordingConfirm] = useState(true);
  const [recordingAutoSleep, setRecordingAutoSleep] = useState("500");
  const [recordingTimeout, setRecordingTimeout] = useState("30");
  const [recordingConfigStep, setRecordingConfigStep] = useState(0);

  // --- IDLE/LOADING LOGIC ---

  // Keep track of data for diffing in onValue
  const currentDataRef = useRef<any>(undefined);

  useEffect(() => {
    setMode("LOADING");
    setError(null);
    setHighlightedItem(null);
    setEvents([]);
    currentDataRef.current = undefined;

    const dbPath = path === "/" ? "/" : path;
    const dbRef = ref(db, dbPath);

    // Main data listener
    const unsubscribe = onValue(
      dbRef,
      (snapshot) => {
        const val = snapshot.exists() ? snapshot.val() : null;

        // Calculate diffs if we have previous data (and it's not the first load)
        if (currentDataRef.current !== undefined) {
          const newDiffs = calculateDiff(currentDataRef.current, val);
          if (newDiffs.length > 0) {
            setEvents((prev) => [...newDiffs, ...prev].slice(0, 100));
          }
        }

        currentDataRef.current = val;
        setData(val);

        if (val && typeof val === "object" && !Array.isArray(val)) {
          setHighlightedItem((prev) => {
            const keys = Object.keys(val);
            if (keys.length > 0) {
              if (!prev || !keys.includes(prev)) {
                return keys[0]!;
              }
              return prev;
            }
            return null;
          });
        }

        setMode((prev) => (prev === "LOADING" ? "BROWSE" : prev));
      },
      (err) => {
        setError(err.message);
        setMode("BROWSE");
      },
    );

    return () => {
      unsubscribe();
    };
  }, [db, path, refreshTrigger]);

  // Conflict detection
  useEffect(() => {
    if (mode === "EDIT_PRIMITIVE" && initialEditValue.current !== null) {
      const currentStr = JSON.stringify(data);
      const initialStr = JSON.stringify(initialEditValue.current);
      if (currentStr !== initialStr) {
        setConflictDetected(true);
      }
    }
  }, [data, mode]);

  // --- HANDLERS ---

  const openExternalEditor = async (filePath: string) => {
    // Try opening with VS Code first, then fall back to system default
    // We use 'code' command for VS Code.
    exec(`code "${filePath.replace(/\\/g, "\\\\")}"`, (error) => {
      if (error) {
        // Fallback for Windows
        exec(`start "" "${filePath.replace(/\\/g, "\\\\")}"`);
      }
    });
  };

  const handleExternalEditStart = async () => {
    if (mode !== "BROWSE" || !data) return;
    try {
      setMode("LOADING");
      setStatusMessage("Preparing external edit...");

      const timestamp = Date.now();
      const fileName = `temp_edit_${timestamp}.json`;
      const filePath = resolve(process.cwd(), fileName);

      // Format JSON for editing
      await writeFile(filePath, JSON.stringify(data, null, 2));
      setTempFilePath(filePath);

      openExternalEditor(filePath);

      setMode("EXTERNAL_EDIT_WAIT");
      setStatusMessage(
        `Editing ${fileName}. Save and close editor, then press ENTER.`,
      );
    } catch (e: any) {
      setStatusMessage(`Failed to start external edit: ${e.message}`);
      setMode("BROWSE");
    }
  };

  const handleExternalEditFinish = async () => {
    if (!tempFilePath) return;
    try {
      setMode("LOADING");
      setStatusMessage("Fetching latest data and calculating diffs...");

      // 1. Read file
      const fileContent = await readFile(tempFilePath, "utf-8");
      let newItem: any;
      try {
        newItem = JSON.parse(fileContent);
      } catch (parseError) {
        setStatusMessage("Error parsing JSON file. Please fix syntax.");
        setMode("EXTERNAL_EDIT_WAIT");
        return;
      }

      // 2. Fetch fresh DB data
      const snapshot = await get(ref(db, path === "/" ? "/" : path));
      const currentDbData = snapshot.exists() ? snapshot.val() : null;

      // 3. Diff
      // If both are primitives, simple check.
      // Using our diff utility
      const calculatedDiffs = calculateDiff(currentDbData, newItem);

      if (calculatedDiffs.length === 0) {
        setStatusMessage("No changes detected.");
        setMode("BROWSE");
        // Clean up file
        try {
          await unlink(tempFilePath);
        } catch {}
        setTempFilePath(null);
      } else {
        setDiffs(calculatedDiffs);
        setDiffCursor(0);
        setMode("DIFF_REVIEW");
        setStatusMessage(null);
      }
    } catch (e: any) {
      setStatusMessage(`Error processing edit: ${e.message}`);
      setMode("BROWSE");
    }
  };

  const applyDiffs = async () => {
    setMode("LOADING");
    setStatusMessage("Applying changes...");
    try {
      // Filter selected diffs
      const selectedDiffs = diffs.filter((d) => d.selected);

      if (selectedDiffs.length === 0) {
        setStatusMessage("No changes selected.");
        setMode("BROWSE");
        return;
      }

      const updatePayload: Record<string, any> = {};
      for (const diff of selectedDiffs) {
        const relativePath = diff.path.join("/");
        if (diff.type === "DELETE") {
          updatePayload[relativePath] = null;
        } else {
          updatePayload[relativePath] = diff.newValue;
        }
      }

      await update(ref(db, path === "/" ? "/" : path), updatePayload);

      // Clean/Success
      try {
        if (tempFilePath) await unlink(tempFilePath);
      } catch {}
      setTempFilePath(null);
      setDiffs([]);
      setStatusMessage("Changes applied successfully!");
      setRefreshTrigger((t) => t + 1); // Triggers loading/browse
    } catch (e: any) {
      setStatusMessage(`Failed to apply changes: ${e.message}`);
      setMode("BROWSE");
    }
  };

  // --- INPUT HANDLING ---

  useInput((input, key) => {
    if (mode === "LOADING") return;

    // --- BROWSE MODE ---
    if (mode === "BROWSE") {
      // Navigation - go back (backspace or delete or escape)
      if ((key.backspace || key.delete || key.escape) && path !== "/") {
        const parts = path.split("/").filter((p) => p);
        parts.pop();
        setPath(parts.length === 0 ? "/" : "/" + parts.join("/"));
        return;
      }

      // Add
      if (input === "a") {
        setMode("ADD_ID");
        // Setup inference
        let keys: string[] = [];
        let values: any[] = [];
        if (data && typeof data === "object") {
          keys = Object.keys(data);
          values = Object.values(data);
        }
        setAddId(inferNextId(keys));
        const schemas = inferSchema(values);
        setAvailableSchemas(schemas);
        setCurrentSchemaIndex(0);
        setAddValue(JSON.stringify(schemas[0] || {}));
        setStatusMessage(null);
        return;
      }

      // Edit primitive
      if (input === "e" && data !== null && typeof data !== "object") {
        setMode("EDIT_PRIMITIVE");
        setEditValue(String(data));
        initialEditValue.current = data;
        setConflictDetected(false);
        setStatusMessage(null);
        return;
      }

      // Delete (r)
      if (
        input === "r" &&
        highlightedItem &&
        data &&
        typeof data === "object"
      ) {
        setMode("DELETE_CONFIRM");
        setItemToDelete(highlightedItem);
        setStatusMessage(null);
        return;
      }

      // Dump / Export
      if (input === "d") {
        setMode("DUMPING");
        setStatusMessage("Dumping data...");
        const rootRef = ref(db, "/");
        get(rootRef)
          .then(async (s) => {
            if (s.exists()) {
              const fName = `dump-${Date.now()}.json`;
              await writeFile(fName, JSON.stringify(s.val(), null, 2));
              setStatusMessage(`Dump saved to ${fName}`);
            } else {
              setStatusMessage("Root is empty.");
            }
            setMode("BROWSE");
          })
          .catch((e) => {
            setStatusMessage("Dump failed: " + e.message);
            setMode("BROWSE");
          });
        return;
      }

      // External Edit (f)
      if (input === "f") {
        handleExternalEditStart();
        return;
      }

      // Set preferred preview field (g)
      // When inside an object, pressing "g" sets the currently highlighted field
      // as the preferred preview for the PARENT path (so sibling objects show this field)
      if (
        input === "g" &&
        path !== "/" &&
        highlightedItem &&
        data &&
        typeof data === "object"
      ) {
        // Get parent path
        const parts = path.split("/").filter((p) => p);
        parts.pop(); // Remove current segment
        const parentPath = parts.length === 0 ? "/" : "/" + parts.join("/");

        // The highlighted item is a field name in the current object
        // Set it as the preferred preview field for the parent path
        setPreferredPreviewFields((prev) => ({
          ...prev,
          [parentPath]: highlightedItem,
        }));
        setStatusMessage(
          `Preview field set to "${highlightedItem}" for ${parentPath}`,
        );
        return;
      }

      // Start Recording (q)
      if (input === "q" && !isRecording) {
        setMode("RECORDING_CONFIG");
        setRecordingConfigStep(0);
        setRecordingPlayMode("normal");
        setRecordingConfirm(true);
        setRecordingAutoSleep("500");
        setRecordingTimeout("30");
        setStatusMessage(null);
        return;
      }

      // Stop Recording and Export (w)
      if (input === "w" && isRecording) {
        setMode("EXPORT_RECORDING");
        setExportFileName(`recording-${Date.now()}.rlsactions`);
        setStatusMessage(null);
        return;
      }

      // Load Recording (l)
      if (input === "l") {
        setMode("LOAD_RECORDING");
        setLoadFilePath("");
        setStatusMessage(null);
        return;
      }

      // Events Mode (v)
      if (input === "v") {
        setMode("EVENTS");
        setEventCursor(0);
        setEventScrollOffset(0);
        setStatusMessage(null);
        return;
      }

      return;
    }

    // --- ADD MODES ---
    if (mode === "ADD_ID") {
      if (key.escape) {
        setMode("BROWSE");
        return;
      }
      return; // Handled by TextInput onSubmit
    }
    if (mode === "ADD_VALUE") {
      if (key.escape) {
        setMode("BROWSE");
        return;
      }
      if (key.tab && availableSchemas.length > 1) {
        const next = (currentSchemaIndex + 1) % availableSchemas.length;
        setCurrentSchemaIndex(next);
        setAddValue(JSON.stringify(availableSchemas[next] || {}));
      }
      return; // Handled by TextInput onSubmit
    }

    // --- EDIT PRIMITIVE ---
    if (mode === "EDIT_PRIMITIVE") {
      if (key.escape) {
        setMode("BROWSE");
        return;
      }
      return; // Handled by TextInput
    }

    // --- DELETE CONFIRM ---
    if (mode === "DELETE_CONFIRM") {
      // Confirm with Enter or y
      if (key.return || input === "y") {
        if (!itemToDelete) {
          setMode("BROWSE");
          return;
        }
        setMode("LOADING");
        const itemPath =
          path === "/" ? `/${itemToDelete}` : `${path}/${itemToDelete}`;
        set(ref(db, itemPath), null)
          .then(() => {
            // Record the delete action
            if (isRecording) {
              recordingManager.recordDelete(itemPath);
            }
            setStatusMessage(`Deleted ${itemToDelete}`);
            setRefreshTrigger((t) => t + 1);
          })
          .catch((e) => {
            setStatusMessage(`Delete failed: ${e.message}`);
            setMode("BROWSE");
          });
        return;
      }
      // Cancel with Esc or n
      if (key.escape || input === "n") {
        setMode("BROWSE");
        setStatusMessage("Deletion cancelled.");
        return;
      }
    }

    // --- EXTERNAL EDIT WAIT ---
    if (mode === "EXTERNAL_EDIT_WAIT") {
      if (key.return) {
        handleExternalEditFinish();
      }
      if (key.escape) {
        setMode("BROWSE");
        setStatusMessage("Edit cancelled.");
        // Try cleanup?
      }
    }

    // --- DIFF REVIEW ---
    if (mode === "DIFF_REVIEW") {
      if (key.upArrow) {
        setDiffCursor((c) => Math.max(0, c - 1));
      }
      if (key.downArrow) {
        setDiffCursor((c) => Math.min(diffs.length - 1, c + 1));
      }
      if (input === " " || key.rightArrow || key.leftArrow) {
        // Toggle
        const newDiffs = [...diffs];
        const target = newDiffs[diffCursor];
        if (target) {
          target.selected = !target.selected;
          setDiffs(newDiffs);
        }
      }
      if (key.return) {
        // Go to confirmation step
        setMode("DIFF_APPLY_CONFIRM");
      }
      if (key.escape) {
        setMode("BROWSE");
        setStatusMessage("Review cancelled. No changes applied.");
      }
    }

    // --- DIFF APPLY CONFIRM ---
    if (mode === "DIFF_APPLY_CONFIRM") {
      if (key.return || input === "y") {
        applyDiffs();
      }
      if (key.escape || input === "n") {
        setMode("DIFF_REVIEW");
        setStatusMessage("Returned to diff review.");
      }
    }

    // --- RECORDING CONFIG ---
    if (mode === "RECORDING_CONFIG") {
      if (key.escape) {
        setMode("BROWSE");
        setStatusMessage("Recording cancelled.");
        return;
      }
      // Step 0: Play Mode selection
      if (recordingConfigStep === 0) {
        if (key.leftArrow || key.rightArrow || input === " ") {
          setRecordingPlayMode((m) => (m === "normal" ? "loop" : "normal"));
        }
        if (key.return) {
          setRecordingConfigStep(1);
        }
        return;
      }
      // Step 1: Confirm for edit/delete
      if (recordingConfigStep === 1) {
        if (key.leftArrow || key.rightArrow || input === " ") {
          setRecordingConfirm((c) => !c);
        }
        if (key.return) {
          setRecordingConfigStep(2);
        }
        return;
      }
      // Step 2: Auto sleep (handled by TextInput)
      // Step 3: Timeout (handled by TextInput)
    }

    // --- EXPORT RECORDING ---
    if (mode === "EXPORT_RECORDING") {
      if (key.escape) {
        setMode("BROWSE");
        setStatusMessage("Export cancelled. Recording continues.");
        return;
      }
      // Handled by TextInput
    }

    // --- LOAD RECORDING ---
    if (mode === "LOAD_RECORDING") {
      if (key.escape) {
        setMode("BROWSE");
        setStatusMessage("Load cancelled.");
        return;
      }
      // Handled by TextInput
    }

    // --- EVENTS MODE ---
    if (mode === "EVENTS") {
      if (key.escape) {
        setMode("BROWSE");
        return;
      }
      if (key.upArrow) {
        setEventCursor((c) => {
          const next = Math.max(0, c - 1);
          if (next < eventScrollOffset) {
            setEventScrollOffset(next);
          }
          return next;
        });
      }
      if (key.downArrow) {
        setEventCursor((c) => {
          const next = Math.min(events.length - 1, c + 1);
          if (next >= eventScrollOffset + 15) {
            setEventScrollOffset(next - 15 + 1);
          }
          return next;
        });
      }

      const event = events[eventCursor];
      if (!event) return;

      const fullPath =
        path === "/"
          ? `/${event.path.join("/")}`
          : `${path}/${event.path.join("/")}`;

      // Repeat (Enter) - Apply newValue again
      if (key.return) {
        if (event.type === "DELETE") {
          set(ref(db, fullPath), null);
        } else {
          set(ref(db, fullPath), event.newValue);
        }
        setStatusMessage("Event repeated.");
      }

      // Revert (r) - Apply oldValue
      if (input === "r") {
        if (event.type === "CREATE") {
          // Revert creation = delete
          set(ref(db, fullPath), null);
          setStatusMessage("Reverted CREATE (Deleted).");
        } else if (event.type === "DELETE") {
          // Revert deletion = restore old value
          set(ref(db, fullPath), event.oldValue);
          setStatusMessage("Reverted DELETE (Restored).");
        } else if (event.type === "EDIT") {
          // Revert edit = set to old value
          set(ref(db, fullPath), event.oldValue);
          setStatusMessage("Reverted EDIT.");
        }
      }

      // Edit & Run (e)
      if (input === "e") {
        setTargetPath(fullPath);
        setEditValue(JSON.stringify(event.newValue));
        setMode("EVENT_EDIT_VALUE");
      }
    }

    // --- EVENT EDIT VALUE ---
    if (mode === "EVENT_EDIT_VALUE") {
      if (key.escape) {
        setMode("EVENTS");
        return;
      }
      // Handled by TextInput
    }
  });

  // --- RENDERING ---

  // Helper function to format a preview value
  const formatPreview = useCallback(
    (val: any, maxLength: number = 40): string => {
      if (val === null) return "null";
      if (val === undefined) return "undefined";

      const type = typeof val;

      if (type === "string") {
        if (val.length > maxLength) {
          return `"${val.substring(0, maxLength - 3)}..."`;
        }
        return `"${val}"`;
      }

      if (type === "number") {
        return String(val);
      }

      if (type === "boolean") {
        return val ? "✓ true" : "✗ false";
      }

      if (Array.isArray(val)) {
        if (val.length === 0) return "[]";
        // Show first few items or count
        const preview = val
          .slice(0, 3)
          .map((item) => {
            if (typeof item === "string") return `"${item.substring(0, 10)}"`;
            if (typeof item === "object") return "{...}";
            return String(item);
          })
          .join(", ");
        if (val.length > 3) {
          return `[${preview}, ...+${val.length - 3}]`;
        }
        return `[${preview}]`;
      }

      if (type === "object") {
        const keys = Object.keys(val);
        if (keys.length === 0) return "{}";
        return `{${keys.length} keys}`;
      }

      return String(val);
    },
    [],
  );

  // Get the preferred preview field for the current path
  const currentPreferredField = useMemo(() => {
    return preferredPreviewFields[path] || null;
  }, [path, preferredPreviewFields]);

  // Helper for SelectInput
  const items = useMemo(() => {
    if (!data || typeof data !== "object") return [];
    return Object.keys(data).map((key) => {
      const val = data[key];
      const type = typeof val;

      // Determine the preview to show
      let preview = "";

      if (type === "object" && val !== null && !Array.isArray(val)) {
        // For objects, use preferred preview field if set
        if (currentPreferredField && val[currentPreferredField] !== undefined) {
          preview = formatPreview(val[currentPreferredField], 30);
        } else {
          // Default: try common fields like name, title, id
          const commonFields = ["name", "title", "label", "id", "key", "value"];
          let found = false;
          for (const field of commonFields) {
            if (val[field] !== undefined) {
              preview = formatPreview(val[field], 30);
              found = true;
              break;
            }
          }
          if (!found) {
            preview = formatPreview(val, 30);
          }
        }
      } else {
        // For primitives and arrays, show the value directly
        preview = formatPreview(val, 35);
      }

      const typeLabel = Array.isArray(val)
        ? "array"
        : type === "object" && val === null
          ? "null"
          : type;

      return {
        label: `${key}  │  ${typeLabel}  │  ${preview}`,
        value: key,
      };
    });
  }, [data, mode, currentPreferredField, formatPreview]);

  return (
    <Box
      flexDirection="column"
      padding={1}
      borderStyle="round"
      borderColor={
        isRecording
          ? "red"
          : mode === "EXTERNAL_EDIT_WAIT"
            ? "magenta"
            : mode === "DIFF_REVIEW"
              ? "blue"
              : mode === "DELETE_CONFIRM"
                ? "red"
                : mode === "RECORDING_CONFIG"
                  ? "magenta"
                  : "yellow"
      }
      width={120}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            DB EXPLORER
          </Text>
          <Text> | </Text>
          <Text color="yellow">{path}</Text>
          {currentPreferredField && (
            <>
              <Text> | </Text>
              <Text color="magenta">Preview: {currentPreferredField}</Text>
            </>
          )}
          {isRecording && (
            <>
              <Text> | </Text>
              <Text bold color="red">
                🔴 REC ({recordingManager.actionCount})
              </Text>
            </>
          )}
        </Box>
        <Box>
          <Text color="gray">Mode: {mode}</Text>
        </Box>
      </Box>

      {statusMessage && (
        <Box marginBottom={1}>
          <Text color="yellow">{statusMessage}</Text>
        </Box>
      )}

      {/* CONTENT AREA */}
      {mode === "LOADING" && (
        <Text color="green">
          <Spinner type="dots" /> Loading...
        </Text>
      )}

      {mode === "BROWSE" && error && <Text color="red">Error: {error}</Text>}

      {mode === "BROWSE" && !error && data === null && (
        <Box flexDirection="column">
          <Text italic color="gray">
            No data at this location.
          </Text>
          <Text color="gray">Press 'a' to add data, 'f' to edit via file.</Text>
        </Box>
      )}

      {/* Primitive View */}
      {mode === "BROWSE" && data !== null && typeof data !== "object" && (
        <Box flexDirection="column">
          <Text bold>Value:</Text>
          <Text color="green">{String(data)}</Text>
          <Box height={1} />
          <Text color="gray">
            Back: BS. Edit: 'e'. Dump: 'd'. File Edit: 'f'.
          </Text>
        </Box>
      )}

      {/* Object View */}
      {mode === "BROWSE" && data !== null && typeof data === "object" && (
        <Box flexDirection="column">
          {items.length === 0 ? (
            <Text italic>Empty object.</Text>
          ) : (
            <SelectInput
              items={items}
              onSelect={(item) =>
                setPath(
                  path === "/" ? `/${item.value}` : `${path}/${item.value}`,
                )
              }
              onHighlight={(item) => setHighlightedItem(item.value)}
              limit={15}
            />
          )}
          <Box height={1} />
          <Text color="gray">
            Nav: ↑↓/Enter/BS. Add: 'a'. Edit(File): 'f'. Del: 'r'. Dump: 'd'.
            Preview: 'g'. Events: 'v'.
          </Text>
          <Text color="gray">
            {isRecording
              ? "Recording: Stop/Export 'w'."
              : "Recording: Start 'q'. Load 'l'."}
          </Text>
        </Box>
      )}

      {/* Add ID */}
      {mode === "ADD_ID" && (
        <Box flexDirection="column">
          <Text>Enter Key/ID:</Text>
          <TextInput
            value={addId}
            onChange={setAddId}
            onSubmit={() => {
              if (addId) setMode("ADD_VALUE");
            }}
          />
          <Text color="gray">Esc to cancel.</Text>
        </Box>
      )}

      {/* Add Value */}
      {mode === "ADD_VALUE" && (
        <Box flexDirection="column">
          <Text>Enter Value (JSON):</Text>
          <TextInput
            value={addValue}
            onChange={setAddValue}
            onSubmit={() => {
              try {
                const val = JSON.parse(addValue);
                setMode("LOADING");
                const newPath = path === "/" ? `/${addId}` : `${path}/${addId}`;
                set(ref(db, newPath), val)
                  .then(() => {
                    // Record the edit action
                    if (isRecording) {
                      recordingManager.recordEdit(newPath, val);
                    }
                    setStatusMessage("Item added.");
                    setRefreshTrigger((t) => t + 1);
                  })
                  .catch((e) => {
                    setStatusMessage("Error: " + e.message);
                    setMode("BROWSE");
                  });
              } catch {
                setStatusMessage("Invalid JSON.");
              }
            }}
          />
          {availableSchemas.length > 1 && (
            <Text color="gray">
              Tab to cycle schemas ({currentSchemaIndex + 1}/
              {availableSchemas.length})
            </Text>
          )}
          <Text color="gray">Esc to cancel.</Text>
        </Box>
      )}

      {/* Edit Primitive */}
      {mode === "EDIT_PRIMITIVE" && (
        <Box flexDirection="column">
          {conflictDetected && (
            <Text color="red" bold>
              WARNING: Value changed in DB while you were editing!
            </Text>
          )}
          <Text>Edit Value:</Text>
          <TextInput
            value={editValue}
            onChange={setEditValue}
            onSubmit={(val) => {
              let finalVal: any = val;
              try {
                finalVal = JSON.parse(val);
              } catch {}
              setMode("LOADING");
              set(ref(db, path), finalVal)
                .then(() => {
                  // Record the edit action
                  if (isRecording) {
                    recordingManager.recordEdit(path, finalVal);
                  }
                  setStatusMessage("Updated.");
                  setRefreshTrigger((t) => t + 1);
                })
                .catch((e) => {
                  setStatusMessage("Update failed: " + e.message);
                  setMode("BROWSE");
                });
            }}
          />
        </Box>
      )}

      {/* Delete Confirm */}
      {mode === "DELETE_CONFIRM" && (
        <Box
          flexDirection="column"
          borderColor="red"
          borderStyle="single"
          padding={1}
        >
          <Text bold color="red">
            WARNING: Deleting {itemToDelete}
          </Text>
          <Text>
            Are you sure you want to delete this item? This cannot be undone.
          </Text>
          <Box height={1} />
          <Text bold>Press 'y' or ENTER to confirm.</Text>
          <Text>Press 'n' or ESC to cancel.</Text>
        </Box>
      )}

      {/* External Edit Wait */}
      {mode === "EXTERNAL_EDIT_WAIT" && (
        <Box flexDirection="column" alignItems="center">
          <Text bold color="magenta">
            External Editing Active
          </Text>
          <Text>Your default editor should have opened.</Text>
          <Text>1. Edit the file: {tempFilePath}</Text>
          <Text>2. Save and Close the file.</Text>
          <Text>3. Press ENTER here to review changes.</Text>
        </Box>
      )}

      {/* Diff Review */}
      {mode === "DIFF_REVIEW" && (
        <Box flexDirection="column">
          <Text bold underline>
            Review Changes ({diffs.filter((d) => d.selected).length}/
            {diffs.length} selected)
          </Text>
          {diffs.map((diff, idx) => (
            <Box key={idx}>
              <Text color={idx === diffCursor ? "cyan" : "white"}>
                {`${diff.selected ? "[x]" : "[ ]"} ${
                  idx === diffCursor ? "> " : "  "
                }`}
              </Text>
              <Text
                color={
                  diff.type === "CREATE"
                    ? "green"
                    : diff.type === "DELETE"
                      ? "red"
                      : "yellow"
                }
              >
                {diff.type} {diff.path.join("/")}
              </Text>
              {diff.type === "EDIT" && (
                <Text color="gray">
                  {(JSON.stringify(diff.oldValue) ?? "undefined").substring(
                    0,
                    20,
                  )}{" "}
                  -{">"}{" "}
                  {(JSON.stringify(diff.newValue) ?? "undefined").substring(
                    0,
                    20,
                  )}
                </Text>
              )}
            </Box>
          ))}
          <Box height={1} />
          <Text color="gray">
            Space: Toggle. Enter: Confirm & Apply. Esc: Cancel.
          </Text>
        </Box>
      )}

      {/* Diff Apply Confirm */}
      {mode === "DIFF_APPLY_CONFIRM" && (
        <Box
          flexDirection="column"
          borderColor="green"
          borderStyle="single"
          padding={1}
        >
          <Text bold color="green">
            CONFIRM CHANGES
          </Text>
          <Text>
            You are about to apply {diffs.filter((d) => d.selected).length}{" "}
            change(s):
          </Text>
          <Box height={1} />
          {diffs
            .filter((d) => d.selected)
            .map((diff, idx) => (
              <Text
                key={idx}
                color={
                  diff.type === "CREATE"
                    ? "green"
                    : diff.type === "DELETE"
                      ? "red"
                      : "yellow"
                }
              >
                • {diff.type}: {diff.path.join("/")}
              </Text>
            ))}
          <Box height={1} />
          <Text bold>Press 'y' or ENTER to apply changes.</Text>
          <Text>Press 'n' or ESC to go back to review.</Text>
        </Box>
      )}

      {/* Recording Config */}
      {mode === "RECORDING_CONFIG" && (
        <Box
          flexDirection="column"
          borderColor="magenta"
          borderStyle="round"
          padding={1}
        >
          <Text bold color="magenta">
            🎬 RECORDING CONFIGURATION
          </Text>
          <Box height={1} />

          {/* Step 0: Play Mode */}
          {recordingConfigStep === 0 && (
            <Box flexDirection="column">
              <Text>Select Play Mode:</Text>
              <Box>
                <Text color={recordingPlayMode === "normal" ? "green" : "gray"}>
                  {recordingPlayMode === "normal" ? "● " : "○ "}normal
                </Text>
                <Text> </Text>
                <Text color={recordingPlayMode === "loop" ? "green" : "gray"}>
                  {recordingPlayMode === "loop" ? "● " : "○ "}loop
                </Text>
              </Box>
              <Box height={1} />
              <Text color="gray">←/→/SPACE to toggle, ENTER to continue</Text>
            </Box>
          )}

          {/* Step 1: Confirm Actions */}
          {recordingConfigStep === 1 && (
            <Box flexDirection="column">
              <Text>Confirm edit/delete actions during playback?</Text>
              <Box>
                <Text color={recordingConfirm ? "green" : "gray"}>
                  {recordingConfirm ? "● " : "○ "}Yes
                </Text>
                <Text> </Text>
                <Text color={!recordingConfirm ? "green" : "gray"}>
                  {!recordingConfirm ? "● " : "○ "}No
                </Text>
              </Box>
              <Box height={1} />
              <Text color="gray">←/→/SPACE to toggle, ENTER to continue</Text>
            </Box>
          )}

          {/* Step 2: Auto Sleep */}
          {recordingConfigStep === 2 && (
            <Box flexDirection="column">
              <Text>Auto sleep between actions (ms):</Text>
              <TextInput
                value={recordingAutoSleep}
                onChange={setRecordingAutoSleep}
                onSubmit={() => setRecordingConfigStep(3)}
              />
              <Text color="gray">Enter a number, then ENTER to continue</Text>
            </Box>
          )}

          {/* Step 3: Timeout */}
          {recordingConfigStep === 3 && (
            <Box flexDirection="column">
              <Text>Playback timeout (seconds):</Text>
              <TextInput
                value={recordingTimeout}
                onChange={setRecordingTimeout}
                onSubmit={() => {
                  // Start recording with configured settings
                  recordingManager.start();
                  recordingManager.updateHeader({
                    playMode: recordingPlayMode,
                    confirmActions: recordingConfirm,
                    autoSleepMs: parseInt(recordingAutoSleep) || 500,
                    timeoutSeconds: parseInt(recordingTimeout) || 30,
                  });
                  setIsRecording(true);
                  setMode("BROWSE");
                  setStatusMessage(
                    "🔴 Recording started! Press 'w' to stop and export.",
                  );
                }}
              />
              <Text color="gray">
                Enter a number, then ENTER to start recording
              </Text>
            </Box>
          )}

          <Box height={1} />
          <Text color="gray">ESC to cancel</Text>
        </Box>
      )}

      {/* Export Recording */}
      {mode === "EXPORT_RECORDING" && (
        <Box
          flexDirection="column"
          borderColor="green"
          borderStyle="round"
          padding={1}
        >
          <Text bold color="green">
            💾 EXPORT RECORDING
          </Text>
          <Text>Recorded {recordingManager.actionCount} action(s)</Text>
          <Box height={1} />
          <Text>Enter filename:</Text>
          <TextInput
            value={exportFileName}
            onChange={setExportFileName}
            onSubmit={async (filename) => {
              try {
                const recording = recordingManager.stop();
                const content = recordingManager.export();
                await writeFile(filename, content);
                setIsRecording(false);
                setStatusMessage(`Recording saved to ${filename}`);
                setMode("BROWSE");
              } catch (e: any) {
                setStatusMessage(`Export failed: ${e.message}`);
              }
            }}
          />
          <Box height={1} />
          <Text color="gray">
            ENTER to save, ESC to cancel (keep recording)
          </Text>
        </Box>
      )}

      {/* Load Recording */}
      {mode === "LOAD_RECORDING" && (
        <Box
          flexDirection="column"
          borderColor="cyan"
          borderStyle="round"
          padding={1}
        >
          <Text bold color="cyan">
            📂 LOAD RECORDING
          </Text>
          <Box height={1} />
          <Text>Enter .rlsactions file path:</Text>
          <TextInput
            value={loadFilePath}
            onChange={setLoadFilePath}
            onSubmit={(filePath) => {
              if (onStartPlayback) {
                onStartPlayback(filePath);
              } else {
                setStatusMessage("Playback not configured.");
                setMode("BROWSE");
              }
            }}
          />
          <Box height={1} />
          <Text color="gray">ENTER to load, ESC to cancel</Text>
        </Box>
      )}

      {/* Events Mode */}
      {mode === "EVENTS" && (
        <Box flexDirection="column">
          <Text bold color="blue">
            EVENTS LOG (Latest first)
          </Text>
          {events.length === 0 && <Text italic>No events captured yet.</Text>}
          {events
            .slice(eventScrollOffset, eventScrollOffset + 15)
            .map((ev, idx) => {
              const realIdx = idx + eventScrollOffset;
              return (
                <Box key={realIdx}>
                  <Text color={realIdx === eventCursor ? "cyan" : "white"}>
                    {realIdx === eventCursor ? "> " : "  "}
                  </Text>
                  <Text
                    color={
                      ev.type === "CREATE"
                        ? "green"
                        : ev.type === "DELETE"
                          ? "red"
                          : "yellow"
                    }
                  >
                    {ev.type} {ev.path.join("/")}
                  </Text>
                  {ev.type === "EDIT" && (
                    <Text color="gray">
                      {" "}
                      {JSON.stringify(ev.oldValue)?.substring(0, 15)} -{">"}{" "}
                      {JSON.stringify(ev.newValue)?.substring(0, 15)}
                    </Text>
                  )}
                  {ev.type !== "EDIT" && (
                    <Text color="gray">
                      {" "}
                      {JSON.stringify(
                        ev.type === "CREATE" ? ev.newValue : ev.oldValue,
                      )?.substring(0, 30)}
                    </Text>
                  )}
                </Box>
              );
            })}
          <Box height={1} />
          <Text color="gray">
            Enter: Repeat. 'e': Edit & Run. 'r': Revert (Inverse). Esc: Back.
          </Text>
        </Box>
      )}

      {/* Event Edit Value */}
      {mode === "EVENT_EDIT_VALUE" && (
        <Box flexDirection="column">
          <Text bold color="blue">
            EDIT EVENT VALUE
          </Text>
          <Text>Path: {targetPath}</Text>
          <Text>Enter New Value (JSON):</Text>
          <TextInput
            value={editValue}
            onChange={setEditValue}
            onSubmit={(val) => {
              let finalVal: any = val;
              try {
                finalVal = JSON.parse(val);
              } catch {}
              if (targetPath) {
                set(ref(db, targetPath), finalVal)
                  .then(() => {
                    setStatusMessage("Event executed with new value.");
                    setMode("EVENTS");
                  })
                  .catch((e) => {
                    setStatusMessage("Failed: " + e.message);
                    setMode("EVENTS");
                  });
              }
            }}
          />
          <Text color="gray">Esc to cancel.</Text>
        </Box>
      )}
    </Box>
  );
}
