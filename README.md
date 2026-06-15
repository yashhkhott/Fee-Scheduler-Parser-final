# Fee Schedule PDF Ingestion Platform

A premium, highly aesthetic, and high-performance ingestion platform for parsing dental insurance carrier fee schedules (multi-page PDFs) into structured database records using Vite, React, Fastify, TypeScript, and Google's Gemini API.

---

## 🌟 Features
- **Modern Obsidian Theme**: Visually stunning dashboard built with custom glassmorphic elements, glowing states, vibrant gradients, and responsive typography.
- **Background Parser Worker**: Queue-based background worker supporting parallel page processing, automatic retries with exponential backoffs, and batched Postgres inserts.
- **Server-Sent Events (SSE)**: Live status board showing dynamic ETA, rows count ticker, and page-by-page grid strips updating in real-time.
- **Interactive Allowed-Fee Browser**: Paginated CDT code keyword search engine with custom CSV stream exporting.
- **Zero-Configuration Resilient Fallbacks**:
  - *No Postgres?* The system automatically flags a warning and falls back to a clean, fast in-memory database store.
  - *No Gemini API Key?* The system automatically activates **Simulation Mode**, extracting and synthesizing highly realistic dental billing records for instant trial.

---

## 🚀 Quick Start Instructions

Follow these quick commands to spin up the local prototype inside your workspace:

### 1. (Optional) Run local Postgres
If you have Docker installed and running, spin up the containerized database:
```bash
docker compose up -d
```
*Note: If you do not have Docker running, do not worry! The backend will automatically trigger the in-memory fallback.*

### 2. Configure Environment variables
Copy the `.env.example` in the backend to `.env` (already done by Antigravity):
- Open `backend/.env`
- (Optional) Provide your real `GEMINI_API_KEY` to run live LLM parsing. If left blank, simulation mode will handle parses.

### 3. Spin up Backend API & Worker
Open a terminal panel and run:
```bash
cd backend
npm run dev
```
The backend API server boots up on `http://localhost:4000`. It will automatically connect to Postgres (or memory), verify the schema tables, and stand ready to accept uploads.

### 4. Spin up Frontend Portal
Open a second terminal panel and run:
```bash
cd frontend
npm run dev
```
The Vite React web server launches on `http://localhost:5173`. Open this URL in your web browser to experience the platform!

---

## 🧪 Pipeline Dry-Run Harness
To verify that text extraction and page segmentation execute correctly on your local machine, run the pre-configured dry-run test harness:
```bash
cd backend
npx tsx src/test-parse.ts
```
This script reads the project spec PDF, segmenting its pages and validating extraction models in real-time.
