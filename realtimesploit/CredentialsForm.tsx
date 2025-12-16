import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { FirebaseConfig } from './types';

interface Props {
    onSubmit: (config: FirebaseConfig) => void;
}

export default function CredentialsForm({ onSubmit }: Props) {
    const [field, setField] = useState(0);
    const [apiKey, setApiKey] = useState('');
    const [projectId, setProjectId] = useState('');
    const [databaseURL, setDatabaseURL] = useState('');

    const fields = [
        { label: 'API Key', value: apiKey, onChange: setApiKey, placeholder: 'AIza...' },
        { label: 'Project ID', value: projectId, onChange: setProjectId, placeholder: 'my-project-id' },
        { label: 'Database URL', value: databaseURL, onChange: setDatabaseURL, placeholder: 'https://my-project.firebaseio.com' },
    ];

    useInput((input, key) => {
        if (key.return) {
            if (field < fields.length - 1) {
                setField(field + 1);
            } else {
                onSubmit({
                    apiKey,
                    projectId,
                    databaseURL
                });
            }
        }
        if (key.upArrow) {
            setField(Math.max(0, field - 1));
        }
        if (key.downArrow) {
            setField(Math.min(fields.length - 1, field + 1));
        }
    });

    return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1} width={80}>
            <Text bold color="green" underline>Firebase Configuration</Text>
            <Box height={1} />
            {fields.map((f, i) => (
                <Box key={i} flexDirection="row">
                    <Box width={15}>
                        <Text color={i === field ? 'green' : 'white'} bold={i === field}>
                            {f.label}:
                        </Text>
                    </Box>
                    <Box>
                        {i === field ? (
                            <TextInput
                                value={f.value}
                                onChange={f.onChange}
                                placeholder={f.placeholder}
                            />
                        ) : (
                            <Text color="gray">{f.value || '...'}</Text>
                        )}
                    </Box>
                </Box>
            ))}
            <Box height={1} />
            <Text color="gray" italic>Press Enter to next/submit. Up/Down to switch fields.</Text>
        </Box>
    );
}
