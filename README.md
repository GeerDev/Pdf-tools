# Pdf Tools

## Prerequisites

### 1. Create required folders

```bash
mkdir pdfs
mkdir excels
```

Place your PDF invoices inside the `pdfs/` folder. The `excels/` folder is where generated Excel exports will be saved.

### 2. Set up environment variables

Copy the provided template and fill in your values:

```bash
cp .env.template .env
```

Then edit `.env`:

```env
GEMINI_API_KEY=        # Google Gemini API key (required for AI extraction)
MONGODB_URI=           # MongoDB connection string (e.g. mongodb://localhost:27017)
MONGODB_DB=            # Database name (e.g. pdf-tools)
AUTH_USER=             # Username for the web UI login
AUTH_PASS=             # Password for the web UI login
```

## Installation

```bash
bun install
```

## Usage

### Extract & process PDFs

```bash
bun run start
```

Runs the 2-phase extraction (REGEX + PDF.js, optionally Gemini AI) and saves results to MongoDB. At the end you will be prompted to export data to Excel.

### Web UI

```bash
bun run server
```

Starts the web server. Open your browser at:

```
http://localhost:3000
```

You will be prompted for the credentials set in `AUTH_USER` and `AUTH_PASS`.
