import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import CredentialsForm from './CredentialsForm';
import Explorer from './Explorer';
import type { FirebaseConfig } from './types';
import { initializeApp } from 'firebase/app';
import { getDatabase, Database } from 'firebase/database';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

export default function App() {
    const [db, setDb] = useState<Database | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadingConfig, setLoadingConfig] = useState(true);

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

    useEffect(() => {
        const loadConfig = async () => {
            try {
                const p = resolve(process.cwd(), 'firebase.json');
                const content = await readFile(p, 'utf-8');
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
                {error && <Text color="red" bold>Error: {error}</Text>}
                <CredentialsForm onSubmit={handleCredentialsSubmit} />
            </Box>
        );
    }

    return <Explorer db={db} />;
}
