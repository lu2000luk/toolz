import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { Database, ref, get, set, update } from "firebase/database";
import { writeFile, readFile, unlink } from "fs/promises";
import { exec } from "child_process";
import { resolve } from "path";
import { inferNextId, inferSchema } from "./schemaUtils.ts";
import { calculateDiff, type DiffChange } from "./diffUtils.ts";

interface ExplorerProps {
	db: Database;
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
	| "LOADING";

export default function Explorer({ db }: ExplorerProps) {
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

	// Preferred preview field per parent path (e.g., "/users" -> "name")
	const [preferredPreviewFields, setPreferredPreviewFields] = useState<
		Record<string, string>
	>({});

	// --- IDLE/LOADING LOGIC ---

	useEffect(() => {
		let active = true;
		setMode("LOADING");
		setError(null);
		setHighlightedItem(null);

		const dbPath = path === "/" ? "/" : path;
		const dbRef = ref(db, dbPath);

		get(dbRef)
			.then((snapshot) => {
				if (active) {
					if (snapshot.exists()) {
						const val = snapshot.val();
						setData(val);
						// Initialize highlightedItem to first key if data is an object
						if (val && typeof val === "object" && !Array.isArray(val)) {
							const keys = Object.keys(val);
							if (keys.length > 0) {
								setHighlightedItem(keys[0]!);
							}
						}
					} else {
						setData(null);
					}
					setMode("BROWSE");
				}
			})
			.catch((err) => {
				if (active) {
					setError(err.message);
					setMode("BROWSE"); // Go back to browse even on error to allow nav
				}
			});

		return () => {
			active = false;
		};
	}, [db, path, refreshTrigger]);

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
				`Editing ${fileName}. Save and close editor, then press ENTER.`
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
					`Preview field set to "${highlightedItem}" for ${parentPath}`
				);
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
		[]
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
				mode === "EXTERNAL_EDIT_WAIT"
					? "magenta"
					: mode === "DIFF_REVIEW"
					? "blue"
					: mode === "DELETE_CONFIRM"
					? "red"
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
									path === "/" ? `/${item.value}` : `${path}/${item.value}`
								)
							}
							onHighlight={(item) => setHighlightedItem(item.value)}
							limit={15}
						/>
					)}
					<Box height={1} />
					<Text color="gray">
						Nav: ↑↓/Enter/BS. Add: 'a'. Edit(File): 'f'. Del: 'r'. Dump: 'd'.
						Preview: 'g'.
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
										20
									)}{" "}
									-{">"}{" "}
									{(JSON.stringify(diff.newValue) ?? "undefined").substring(
										0,
										20
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
		</Box>
	);
}
