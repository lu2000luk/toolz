# RealtimeSploit - Firebase Realtime Database Explorer

A TUI tool to explore Firebase Realtime Databases.

## Prerequisites

- [Bun](https://bun.sh/) (or Node.js)

## Installation

```bash
bun install
```

## Usage

Start the explorer:

```bash
bun start
```

### Configuration

You can provide credentials in two ways:

1.  **Interactive Mode**: Enter details when prompted.
2.  **File Mode**: Create a `firebase.json` file in the root directory (same as `package.json`).

**`firebase.json` format:**

```json
{
	"apiKey": "AIza...",
	"databaseURL": "https://project-id.firebaseio.com",
	"projectId": "project-id"
}
```

If this file exists, the tool will automatically load it.

On first run without a file, you will be prompted to enter your Firebase Client Credentials:

- **API Key**
- **Project ID**
- **Database URL**
