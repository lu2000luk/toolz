import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { Database, ref, get, set } from "firebase/database";
import { writeFile } from "fs/promises";
import { inferNextId, inferSchema } from "./schemaUtils.ts";

interface ExplorerProps {
	db: Database;
}

export default function Explorer({ db }: ExplorerProps) {
	const [path, setPath] = useState<string>("/");
	const [data, setData] = useState<any>(undefined);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dumping, setDumping] = useState(false);
	const [dumpStatus, setDumpStatus] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const [writeStatus, setWriteStatus] = useState<string | null>(null);

	// Add Mode State
	const [isAdding, setIsAdding] = useState(false);
	const [addStep, setAddStep] = useState<"id" | "value">("id");
	const [addId, setAddId] = useState("");
	const [addValue, setAddValue] = useState("");
	const [addStatus, setAddStatus] = useState<string | null>(null);
	const [refreshTrigger, setRefreshTrigger] = useState(0);

	// Schema options
	const [availableSchemas, setAvailableSchemas] = useState<any[]>([]);
	const [currentSchemaIndex, setCurrentSchemaIndex] = useState(0);

	// Highlight tracking
	const [highlightedItem, setHighlightedItem] = useState<string | null>(null);
	const [deleteStatus, setDeleteStatus] = useState<string | null>(null);

	// Fetch data when path changes
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		setDumpStatus(null);
		setHighlightedItem(null);

		// Normalize path
		const dbPath = path === "/" ? "/" : path;
		const dbRef = ref(db, dbPath);

		get(dbRef)
			.then((snapshot) => {
				if (active) {
					if (snapshot.exists()) {
						setData(snapshot.val());
					} else {
						setData(null); // Explicit null for no data/null
					}
				}
			})
			.catch((err) => {
				if (active) {
					setError(err.message);
					setData(undefined);
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});

		return () => {
			active = false;
		};
	}, [db, path, refreshTrigger]);

	const handleAddSubmit = useCallback(() => {
		setLoading(true);
		let finalVal: any = addValue;
		try {
			finalVal = JSON.parse(addValue);
		} catch {
			// Fallback to string if not valid JSON, but for objects we prefer JSON
			// If the user wants a string, they should quote it in JSON
			setAddStatus("Invalid JSON. Please provide valid JSON.");
			setLoading(false);
			return;
		}

		const newPath = path === "/" ? `/${addId}` : `${path}/${addId}`;
		set(ref(db, newPath), finalVal)
			.then(() => {
				setAddStatus(null);
				setIsAdding(false);
				setRefreshTrigger((t) => t + 1);
			})
			.catch((e) => {
				setAddStatus(`Add failed: ${e.message}`);
			})
			.finally(() => setLoading(false));
	}, [db, path, addId, addValue]);

	useInput((input, key) => {
		// Disable global navigation keys while editing or adding
		if (isEditing) {
			// Allow Escape to cancel editing
			if (key.escape) {
				setIsEditing(false);
				setWriteStatus(null);
			}
			return;
		}

		if (isAdding) {
			if (key.escape) {
				setIsAdding(false);
				setAddStatus(null);
			}
			return;
		}

		// Edit mode toggle (only for leaf nodes)
		if (
			input === "e" &&
			!loading &&
			data !== null &&
			typeof data !== "object"
		) {
			setIsEditing(true);
			setEditValue(String(data));
			setWriteStatus(null);
			return;
		}

		// Add mode toggle
		if (input === "a" && !loading && !isEditing && !dumping) {
			setIsAdding(true);
			setAddStep("id");
			setAddStatus(null);

			// Logic to infer ID and Schema
			let keys: string[] = [];
			let values: any[] = [];

			if (data && typeof data === "object") {
				keys = Object.keys(data);
				values = Object.values(data);
			}

			const nextId = inferNextId(keys);
			setAddId(nextId);

			const schemas = inferSchema(values);
			setAvailableSchemas(schemas);
			setCurrentSchemaIndex(0);

			// Default to empty object if schema is empty/null, or JSON string of it
			setAddValue(JSON.stringify(schemas[0] || {}));
			return;
		}

		// Cycle Schemas
		if (
			isAdding &&
			addStep === "value" &&
			key.tab &&
			availableSchemas.length > 1
		) {
			const nextIndex = (currentSchemaIndex + 1) % availableSchemas.length;
			setCurrentSchemaIndex(nextIndex);
			setAddValue(JSON.stringify(availableSchemas[nextIndex] || {}));
			return;
		}

		// Deletion
		if (
			key.delete &&
			!isAdding &&
			!isEditing &&
			!dumping &&
			highlightedItem &&
			data &&
			typeof data === "object"
		) {
			const itemPath =
				path === "/" ? `/${highlightedItem}` : `${path}/${highlightedItem}`;
			set(ref(db, itemPath), null)
				.then(() => {
					setDeleteStatus(`Deleted ${highlightedItem}`);
					// Clean up immediately? Listener should handle it.
				})
				.catch((e) => {
					setDeleteStatus(`Delete failed: ${e.message}`);
				});
			return;
		}
		// Dump logic
		if (input === "d" && !dumping && !loading) {
			setDumping(true);
			setDumpStatus("Fetching full database dump...");

			const rootRef = ref(db, "/");
			get(rootRef)
				.then(async (snapshot) => {
					if (snapshot.exists()) {
						const val = snapshot.val();
						const timestamp = Date.now();
						const filename = `dump-${timestamp}.json`;
						await writeFile(filename, JSON.stringify(val, null, 2));
						setDumpStatus(`Dump saved to ${filename}`);
					} else {
						setDumpStatus("Nothing to dump (root is empty).");
					}
				})
				.catch((err) => {
					setDumpStatus(`Dump failed: ${err.message}`);
				})
				.finally(() => {
					setDumping(false);
				});
			return;
		}

		// Back navigation
		if (key.backspace && path !== "/") {
			const parts = path.split("/").filter((p) => p);
			parts.pop();
			setPath(parts.length === 0 ? "/" : "/" + parts.join("/"));
		}
		// Quit on Ctrl+C is handled by ink default, but Escape could be "Back" too?
		if (key.escape && path !== "/") {
			const parts = path.split("/").filter((p) => p);
			parts.pop();
			setPath(parts.length === 0 ? "/" : "/" + parts.join("/"));
		}
	});

	const handleSelect = (item: { label: string; value: string }) => {
		// Cleanly construct path
		const newPath = path === "/" ? `/${item.value}` : `${path}/${item.value}`;
		setPath(newPath);
	};

	// Prepare list items
	const items = useMemo(() => {
		if (!data || typeof data !== "object") return [];

		return Object.keys(data).map((key) => {
			const val = data[key];
			const type = typeof val;
			const isObj = type === "object" && val !== null;
			// Truncate value preview
			let preview = "";
			if (!isObj) {
				preview = String(val).substring(0, 30);
			} else {
				preview = "{...}";
			}

			return {
				label: `${key}  |  ${
					type === "object" && val === null ? "null" : type
				} ${preview}`,
				value: key,
			};
		});
	}, [data]);

	return (
		<Box
			flexDirection="column"
			padding={1}
			borderStyle="round"
			borderColor="yellow"
			width={80}
		>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					RESPLOIT EXPLORER
				</Text>
				<Text> | </Text>
				<Text color="yellow">{path}</Text>
				{dumping && <Text color="magenta"> | DUMPING...</Text>}
				{isAdding && <Text color="green"> | ADDING...</Text>}
			</Box>

			{loading && (
				<Box>
					<Text color="green">
						<Spinner type="dots" /> Loading...
					</Text>
				</Box>
			)}

			{isAdding && !loading && (
				<Box
					flexDirection="column"
					borderColor="green"
					borderStyle="round"
					padding={1}
				>
					<Text bold underline>
						Add New Item
					</Text>
					{addStep === "id" ? (
						<Box>
							<Text>ID: </Text>
							<TextInput
								value={addId}
								onChange={setAddId}
								onSubmit={() => setAddStep("value")}
							/>
						</Box>
					) : (
						<Box flexDirection="column">
							<Box>
								<Text>Value (JSON): </Text>
								<TextInput
									value={addValue}
									onChange={setAddValue}
									onSubmit={handleAddSubmit}
								/>
							</Box>
							<Text color="gray">
								{availableSchemas.length > 1
									? `Detected Schema ${currentSchemaIndex + 1}/${
											availableSchemas.length
									  } (Tab to cycle).`
									: "Detected Schema used as default."}
							</Text>
						</Box>
					)}
					<Box height={1} />
					<Text color="gray">Press Enter to confirm, Esc to cancel.</Text>
					{addStatus && <Text color="red">{addStatus}</Text>}
				</Box>
			)}

			{isAdding ? null : (
				<>
					{dumpStatus && (
						<Box
							marginBottom={1}
							borderStyle="single"
							borderColor={dumpStatus.includes("failed") ? "red" : "green"}
						>
							<Text
								bold
								color={dumpStatus.includes("failed") ? "red" : "green"}
							>
								{dumpStatus}
							</Text>
						</Box>
					)}

					{deleteStatus && (
						<Box marginBottom={1}>
							<Text color="red">{deleteStatus}</Text>
						</Box>
					)}

					{error && (
						<Box>
							<Text color="red" bold>
								Error: {error}
							</Text>
						</Box>
					)}

					{!loading && !error && data === null && (
						<Box flexDirection="column">
							<Text italic color="gray">
								No data at this location.
							</Text>
							<Text color="gray">Press 'a' to add data here.</Text>
						</Box>
					)}
				</>
			)}

			{!isAdding &&
				!loading &&
				!error &&
				data !== null &&
				typeof data !== "object" && (
					<Box flexDirection="column">
						<Text bold underline>
							Value:
						</Text>
						{isEditing ? (
							<Box flexDirection="column">
								<Box>
									<Text color="green">{"> "}</Text>
									<TextInput
										value={editValue}
										onChange={setEditValue}
										onSubmit={(val) => {
											setLoading(true);
											// Try to parse as JSON first (to support numbers, booleans, quoted strings)
											let finalVal: any = val;
											try {
												finalVal = JSON.parse(val);
											} catch {
												// Keep as string
											}

											set(ref(db, path), finalVal)
												.then(() => {
													setWriteStatus("Value updated successfully!");
													setIsEditing(false);
													setData(finalVal);
												})
												.catch((e) => {
													setWriteStatus(`Update failed: ${e.message}`);
													setIsEditing(false);
												})
												.finally(() => setLoading(false));
										}}
									/>
								</Box>
								<Text color="gray">Press Enter to save, Esc to cancel.</Text>
							</Box>
						) : (
							<Text color="green">{String(data)}</Text>
						)}

						<Box height={1} />
						{writeStatus && (
							<Text color={writeStatus.includes("failed") ? "red" : "green"}>
								{writeStatus}
							</Text>
						)}
						<Text color="gray">
							Press Backspace to go back. 'd' to dump all. 'e' to edit.
						</Text>
					</Box>
				)}

			{!isAdding &&
				!loading &&
				!error &&
				typeof data === "object" &&
				data !== null && (
					<Box flexDirection="column">
						{items.length === 0 ? (
							<Text italic>Empty object.</Text>
						) : (
							<>
								<Box marginBottom={1}>
									<Text bold>Keys ({items.length}):</Text>
								</Box>
								<SelectInput
									items={items}
									onSelect={handleSelect}
									onHighlight={(item) => setHighlightedItem(item.value)}
									limit={10}
								/>
							</>
						)}
						<Box height={1} />
						<Box height={1} />
						<Text color="gray">
							Enter to explore. Backspace to go up. 'a' to add. 'd' to dump. Del
							to delete.
						</Text>
					</Box>
				)}
		</Box>
	);
}
