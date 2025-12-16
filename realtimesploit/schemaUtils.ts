
export function inferNextId(keys: string[]): string {
    if (keys.length === 0) return 'item_1';

    // Check for numeric keys
    const numericKeys = keys.filter(k => !isNaN(Number(k))).map(Number);
    if (numericKeys.length > 0 && numericKeys.length === keys.length) {
        return (Math.max(...numericKeys) + 1).toString();
    }

    // Check for "prefix_number" or "prefix-number" or "prefixNumber"
    // Regex to capture prefix and number
    const pattern = /^([a-zA-Z0-9_\-]+?)[\-_]?(\d+)$/;
    let maxNum = -1;
    let consistentPrefix: string | null = null;
    let consistentSeparator: string = '_'; // Default separator if we can't infer it

    for (const key of keys) {
        const match = key.match(pattern);
        if (match) {
            // match[1] and match[2] should be defined if match is not null
            const prefix = match[1] as string;
            const numStr = match[2] as string;
            const num = parseInt(numStr, 10);

            if (consistentPrefix === null) {
                consistentPrefix = prefix;
                // Try to guess separator from the first match
                // Logic: key starts with prefix. The part after prefix and before number is separator
                const separatorMatch = key.substring(prefix.length, key.length - numStr.length);
                if (separatorMatch) consistentSeparator = separatorMatch;
                else consistentSeparator = ''; // No separator like item1
            }

            if (consistentPrefix === prefix) {
                if (num > maxNum) maxNum = num;
            }
        }
    }

    if (consistentPrefix !== null && maxNum !== -1) {
        return `${consistentPrefix}${consistentSeparator}${maxNum + 1}`;
    }

    // Fallback: standard naming
    return `item_${keys.length + 1}`;
}

export function inferSchema(values: any[]): any[] {
    if (values.length === 0) return [''];

    // We only care about objects
    const objects = values.filter(v => v && typeof v === 'object' && !Array.isArray(v));
    if (objects.length === 0) {
        // If they are primitives, suggest the type of the first one
        const first = values[0];
        if (typeof first === 'string') return [""];
        if (typeof first === 'number') return [0];
        if (typeof first === 'boolean') return [false];
        return [""];
    }

    const signatureCounts: Record<string, { count: number, example: any }> = {};

    for (const obj of objects) {
        const keys = Object.keys(obj).sort();
        const signature = keys.join(',');
        if (!signatureCounts[signature]) {
            signatureCounts[signature] = { count: 0, example: obj };
        }
        signatureCounts[signature].count++;
    }

    // Sort by count descending
    const sorted = Object.values(signatureCounts).sort((a, b) => b.count - a.count);

    // Generate schemas for each distinct signature
    const schemas = sorted.map(entry => {
        const schema: Record<string, any> = {};
        for (const key of Object.keys(entry.example)) {
            const val = entry.example[key];
             let defaultVal: any = null;
            if (typeof val === 'string') defaultVal = "";
            else if (typeof val === 'number') defaultVal = 0;
            else if (typeof val === 'boolean') defaultVal = false;
            else if (typeof val === 'object') defaultVal = {}; // simplified
            schema[key] = defaultVal;
        }
        return schema;
    });

    return schemas;
}
