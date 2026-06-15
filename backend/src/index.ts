import fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

// Load environmental parameters
dotenv.config();

import * as db from './db.js';
import { queueEvents } from './queue.js';
import { pushToQueue, startQueueConsumer } from './servicebus.js';
import { ParseJob } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize folders
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const server = fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true
      }
    }
  }
});

// Register CORS
server.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});

// Register Multipart for uploads
server.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

// ----------------------------------------------------
// ROUTES CONFIGURATION
// ----------------------------------------------------

// 1. Health check & dynamic database stats
server.get('/health', async (request, reply) => {
  return { status: 'healthy', timestamp: new Date().toISOString() };
});

// 2. Fetch all historical parse jobs
server.get('/api/jobs', async (request, reply) => {
  try {
    const jobs = await db.getJobs();
    return jobs;
  } catch (err: any) {
    server.log.error(err);
    reply.status(500).send({ error: 'Failed to retrieve jobs list' });
  }
});

// 3. Get single job metadata
server.get('/api/jobs/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const job = await db.getJob(id);
    if (!job) {
      reply.status(404).send({ error: 'Job not found' });
      return;
    }
    return job;
  } catch (err: any) {
    server.log.error(err);
    reply.status(500).send({ error: 'Failed to retrieve job details' });
  }
});

// 4. Ingest and execute new parse job
server.post('/api/jobs', async (request, reply) => {
  try {
    const data = await request.file();
    if (!data) {
      reply.status(400).send({ error: 'No file uploaded' });
      return;
    }

    // Extract optional metadata fields from form parts
    const carrierHint = (data.fields.carrier_hint as any)?.value || '';
    const planName = (data.fields.plan_name as any)?.value || '';
    const effectiveDate = (data.fields.effective_date as any)?.value || '';

    const jobId = randomUUID();
    const fileExt = path.extname(data.filename) || '.pdf';
    const savedPath = path.join(uploadsDir, `${jobId}${fileExt}`);
    
    // Save file locally
    const writeStream = fs.createWriteStream(savedPath);
    let fileSize = 0;
    
    await new Promise<void>((resolve, reject) => {
      data.file.on('data', (chunk) => {
        fileSize += chunk.length;
      });
      data.file.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => reject(err));
    });

    // Create job details record
    const job: ParseJob = {
      id: jobId,
      source_filename: data.filename,
      blob_path: savedPath,
      carrier_hint: carrierHint || null,
      status: 'queued',
      page_count: 0,
      row_count: 0,
      bytes: fileSize,
      started_at: null,
      completed_at: null,
      duration_ms: null,
      gemini_input_tokens: 0,
      gemini_output_tokens: 0,
      error_summary: null
    };

    await db.createJob(job);
    
    // Trigger background queue execution
    await pushToQueue(jobId);

    return job;
  } catch (err: any) {
    server.log.error(err);
    reply.status(500).send({ error: 'Failed to upload and start job' });
  }
});

// 5. Server-Sent Events (SSE) progress update stream
server.get('/api/jobs/:id/progress', async (request, reply) => {
  const { id } = request.params as { id: string };

  const job = await db.getJob(id);
  if (!job) {
    reply.status(404).send({ error: 'Job not found' });
    return;
  }

  // Set SSE Headers
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Keep-alive heartbeat interval to avoid proxy timeout disconnects
  const keepAlive = setInterval(() => {
    reply.raw.write(': heartbeat\n\n');
  }, 15000);

  // Send current state on connect
  const currentProgress = await db.getJobProgress(id);
  reply.raw.write(`data: ${JSON.stringify({ type: 'init', job, progress: currentProgress })}\n\n`);

  // Event listener function
  const onQueueEvent = (event: any) => {
    if (event.jobId === id) {
      reply.raw.write(`data: ${JSON.stringify({ type: event.type, data: event.data })}\n\n`);
    }
  };

  // Register listener
  queueEvents.on('event', onQueueEvent);

  // Connection close handler
  request.raw.on('close', () => {
    clearInterval(keepAlive);
    queueEvents.off('event', onQueueEvent);
    reply.raw.end();
  });
});

// 6. Paginated & filterable list of parsed rows
server.get('/api/jobs/:id/rows', async (request, reply) => {
  const { id } = request.params as { id: string };
  const query = request.query as {
    page?: string;
    limit?: string;
    search?: string;
    cdtCode?: string;
    carrier?: string;
  };

  const page = Math.max(1, parseInt(query.page || '1', 10));
  const limit = Math.max(1, Math.min(100, parseInt(query.limit || '20', 10)));
  const search = query.search || undefined;
  const cdtCode = query.cdtCode || undefined;
  const carrier = query.carrier || undefined;

  try {
    const data = await db.getFeeScheduleRows(id, { page, limit, search, cdtCode, carrier });
    return data;
  } catch (err: any) {
    server.log.error(err);
    reply.status(500).send({ error: 'Failed to retrieve fee schedule rows' });
  }
});

// 7. CSV Download export of all rows
server.get('/api/jobs/:id/download', async (request, reply) => {
  const { id } = request.params as { id: string };

  try {
    const job = await db.getJob(id);
    if (!job) {
      reply.status(404).send({ error: 'Job not found' });
      return;
    }

    // Fetch all rows at once for export (bypass pagination, limit to large capacity)
    const { rows } = await db.getFeeScheduleRows(id, { page: 1, limit: 1000000 });

    const csvHeaders = [
      'ID', 'Carrier', 'Plan Name', 'Effective Date', 
      'Region', 'CDT Code', 'Procedure Description', 
      'Allowed Amount ($)', 'Modifier', 'Source Page'
    ].join(',');

    const csvRows = rows.map(r => {
      // Escape double quotes inside text fields
      const desc = `"${r.procedure_desc.replace(/"/g, '""')}"`;
      const carrierStr = `"${r.carrier.replace(/"/g, '""')}"`;
      const planNameStr = `"${(r.plan_name || '').replace(/"/g, '""')}"`;
      const regionStr = `"${(r.region || '').replace(/"/g, '""')}"`;
      const effectiveDateStr = r.effective_date || '';

      return [
        r.id,
        carrierStr,
        planNameStr,
        effectiveDateStr,
        regionStr,
        r.cdt_code,
        desc,
        r.allowed_amount,
        r.modifier || '',
        r.source_page
      ].join(',');
    });

    const csvContent = [csvHeaders, ...csvRows].join('\n');
    
    // Set headers for download attachment
    const cleanFilename = job.source_filename.replace(/\.[^/.]+$/, "") + "_parsed.csv";
    
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    
    return csvContent;
  } catch (err: any) {
    server.log.error(err);
    reply.status(500).send({ error: 'Failed to generate CSV export file' });
  }
});

// ----------------------------------------------------
// SERVER STARTUP AND DATABASE BOOTSTRAPPING
// ----------------------------------------------------

const start = async () => {
  try {
    // 1. Boot database layer and verify Postgres
    await db.initDb();

    // 2. Start queue consumer if using Service Bus
    startQueueConsumer();

    // 3. Start fastify listener
    const port = parseInt(process.env.PORT || '4000', 10);
    const host = process.env.HOST || '0.0.0.0';
    
    await server.listen({ port, host });
    console.log(`\n\x1b[32m🚀 FEE SCHEDULE BACKEND RUNNING ON HTTP://${host}:${port}\x1b[0m\n`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
