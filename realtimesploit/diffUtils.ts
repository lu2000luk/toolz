export type ChangeType = "CREATE" | "DELETE" | "EDIT";

export interface DiffChange {
	type: ChangeType;
	key: string; // The key relative to the object root
	path: string[]; // Full path if recursive (simplified to top-level for now or recursive?)
	oldValue: any;
	newValue: any;
	selected: boolean; // For toggling
}

export function calculateDiff(
	original: any,
	modified: any,
	basePath: string[] = []
): DiffChange[] {
	const changes: DiffChange[] = [];

	// If either is not an object (and not null), treat as a direct edit if they differ
	if (
		typeof original !== "object" ||
		original === null ||
		typeof modified !== "object" ||
		modified === null
	) {
		if (original !== modified) {
			return [
				{
					type: "EDIT",
					key: basePath[basePath.length - 1] || "root",
					path: basePath,
					oldValue: original,
					newValue: modified,
					selected: true,
				},
			];
		}
		return [];
	}

	// Compare objects
	const keys1 = Object.keys(original);
	const keys2 = Object.keys(modified);
	const allKeys = new Set([...keys1, ...keys2]);

	for (const key of allKeys) {
		const val1 = original[key];
		const val2 = modified[key];
		const currentPath = [...basePath, key];

		if (!(key in original)) {
			// New key in modified -> CREATE
			changes.push({
				type: "CREATE",
				key: key,
				path: currentPath,
				oldValue: undefined,
				newValue: val2,
				selected: true,
			});
		} else if (!(key in modified)) {
			// Key missing in modified -> DELETE
			changes.push({
				type: "DELETE",
				key: key,
				path: currentPath,
				oldValue: val1,
				newValue: undefined,
				selected: true,
			});
		} else {
			// Key exists in both
			if (JSON.stringify(val1) !== JSON.stringify(val2)) {
				// If both are objects, recurse?
				// The user wants to "toggle certain operations". Reference to "operations" usually implies key-level changes.
				// Deep diffing might be too granular if we just want to say "Updated User/Settings".
				// However, let's do a shallow check first? No, recursive is better for JSON.
				// But for simplicity in UI, maybe we flatten the diffs?

				// Let's do recursive.
				if (
					typeof val1 === "object" &&
					val1 !== null &&
					typeof val2 === "object" &&
					val2 !== null
				) {
					changes.push(...calculateDiff(val1, val2, currentPath));
				} else {
					changes.push({
						type: "EDIT",
						key: key,
						path: currentPath,
						oldValue: val1,
						newValue: val2,
						selected: true,
					});
				}
			}
		}
	}

	return changes;
}
