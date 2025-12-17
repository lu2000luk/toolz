// Recording types for .rlsactions files

export type PlayMode = "normal" | "loop";

export interface ActionHeader {
  playMode: PlayMode;
  confirmActions: boolean; // Confirm for edit/delete actions
  autoSleepMs: number; // Auto sleep per action in ms
  timeoutSeconds: number; // Timeout in seconds
}

export type ActionType = "sleep" | "edit" | "delete" | "get" | "exec";

export interface SleepAction {
  type: "sleep";
  timeMs: number;
}

export interface EditAction {
  type: "edit";
  key: string;
  value: any;
}

export interface DeleteAction {
  type: "delete";
  key: string;
}

export interface GetAction {
  type: "get";
  key: string;
}

export interface ExecAction {
  type: "exec";
  path: string;
  targetBase64: string;
  actionBase64: string;
}

export type RecordedAction =
  | SleepAction
  | EditAction
  | DeleteAction
  | GetAction
  | ExecAction;

export interface RecordingFile {
  header: ActionHeader;
  actions: RecordedAction[];
}

// Default header values
export const DEFAULT_HEADER: ActionHeader = {
  playMode: "normal",
  confirmActions: true,
  autoSleepMs: 500,
  timeoutSeconds: 30,
};

// Parse a .rlsactions file content
export function parseRlsActionsFile(content: string): RecordingFile {
  const lines = content.trim().split("\n");
  if (lines.length === 0) {
    throw new Error("Empty file");
  }

  // Parse header (first line)
  const headerParts = lines[0]!.split(" ");
  if (headerParts.length < 4) {
    throw new Error(
      "Invalid header format. Expected: [playMode] [confirm] [autoSleepMs] [timeoutS]",
    );
  }

  const playMode = headerParts[0] as PlayMode;
  if (playMode !== "normal" && playMode !== "loop") {
    throw new Error(
      `Invalid play mode: ${playMode}. Expected 'normal' or 'loop'`,
    );
  }

  const confirmActions = headerParts[1] === "true";
  const autoSleepMs = parseInt(headerParts[2]!, 10);
  const timeoutSeconds = parseInt(headerParts[3]!, 10);

  if (isNaN(autoSleepMs) || isNaN(timeoutSeconds)) {
    throw new Error(
      "Invalid header: autoSleepMs and timeoutSeconds must be numbers",
    );
  }

  const header: ActionHeader = {
    playMode,
    confirmActions,
    autoSleepMs,
    timeoutSeconds,
  };

  // Parse actions
  const actions: RecordedAction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const parts = line.split(" ");
    const actionType = parts[0];

    switch (actionType) {
      case "sleep": {
        const timeMs = parseInt(parts[1]!, 10);
        if (isNaN(timeMs)) {
          throw new Error(`Invalid sleep time at line ${i + 1}`);
        }
        actions.push({ type: "sleep", timeMs });
        break;
      }
      case "edit": {
        const key = parts[1];
        // Value is the rest of the line after "edit [key] "
        const valueStr = parts.slice(2).join(" ");
        if (!key) {
          throw new Error(`Invalid edit action at line ${i + 1}: missing key`);
        }
        let value: any;
        try {
          value = JSON.parse(valueStr);
        } catch {
          // Treat as string if not valid JSON
          value = valueStr;
        }
        actions.push({ type: "edit", key, value });
        break;
      }
      case "delete": {
        const key = parts[1];
        if (!key) {
          throw new Error(
            `Invalid delete action at line ${i + 1}: missing key`,
          );
        }
        actions.push({ type: "delete", key });
        break;
      }
      case "get": {
        const key = parts[1];
        if (!key) {
          throw new Error(`Invalid get action at line ${i + 1}: missing key`);
        }
        actions.push({ type: "get", key });
        break;
      }
      case "exec": {
        const path = parts[1];
        const targetBase64 = parts[2];
        const actionBase64 = parts[3];

        if (!path || !targetBase64 || !actionBase64) {
          throw new Error(
            `Invalid exec action at line ${i + 1}: missing arguments`,
          );
        }
        actions.push({ type: "exec", path, targetBase64, actionBase64 });
        break;
      }
      default:
        throw new Error(`Unknown action type at line ${i + 1}: ${actionType}`);
    }
  }

  return { header, actions };
}

// Serialize a recording to .rlsactions format
export function serializeRlsActions(recording: RecordingFile): string {
  const lines: string[] = [];

  // Header
  lines.push(
    `${recording.header.playMode} ${recording.header.confirmActions} ${recording.header.autoSleepMs} ${recording.header.timeoutSeconds}`,
  );

  // Actions
  for (const action of recording.actions) {
    switch (action.type) {
      case "sleep":
        lines.push(`sleep ${action.timeMs}`);
        break;
      case "edit":
        lines.push(`edit ${action.key} ${JSON.stringify(action.value)}`);
        break;
      case "delete":
        lines.push(`delete ${action.key}`);
        break;
      case "get":
        lines.push(`get ${action.key}`);
        break;
      case "exec":
        lines.push(
          `exec ${action.path} ${action.targetBase64} ${action.actionBase64}`,
        );
        break;
    }
  }

  return lines.join("\n");
}
