import { EventEmitter } from 'events';
import * as db from './db.js';
import { parsePdfToPages, parsePageRows } from './parser.js';
import { ParseJob, ParseJobProgress } from './types.js';
import { downloadFile } from './storage.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Central Event Emitter for Streaming Progress Events to SSE routes
export const queueEvents = new EventEmitter();

// Active processing queue state
const activeJobs: Set<string> = new Set();

/**
 * Enqueues a job for parsing in the background.
 */
export function enqueueJob(jobId: string) {
  // Spawn background processing async
  processJob(jobId).catch(err => {
    console.error(`[QUEUE ERROR] Fatal job processing failure for ${jobId}:`, err);
  });
}

/**
 * Performs concurrent page-by-page LLM extraction.
 */
async function processJob(jobId: string) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  const startTime = Date.now();
  console.log(`[QUEUE] Starting parse job: ${jobId}`);

  let job = await db.getJob(jobId);
  if (!job) {
    console.error(`[QUEUE] Job ${jobId} not found in database.`);
    activeJobs.delete(jobId);
    return;
  }

  try {
    // 1. Update job to Running status
    job.status = 'running';
    job.started_at = new Date().toISOString();
    await db.updateJob(jobId, {
      status: 'running',
      started_at: job.started_at
    });
    emitJobProgress(jobId, job);

    // 2. Load and segment PDF into pages
    console.log(`[QUEUE] Downloading file if in cloud storage for job: ${jobId}`);
    const localPath = path.join(__dirname, '..', 'uploads', `${jobId}_downloaded.pdf`);
    await downloadFile(job.blob_path, localPath);

    console.log(`[QUEUE] Segmentation started for job: ${jobId}`);
    const pagesText = await parsePdfToPages(localPath);
    const totalPages = pagesText.length;
    console.log(`[QUEUE] Segmented PDF into ${totalPages} text pages for job: ${jobId}`);

    // Update job page count
    job.page_count = totalPages;
    await db.updateJob(jobId, { page_count: totalPages });
    emitJobProgress(jobId, job);

    let completedPages = 0;
    let totalExtractedRows = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    // 3. Process pages in parallel chunks (Concurrency: 4)
    const concurrency = 4;
    const pageIndices = Array.from({ length: totalPages }, (_, i) => i);
    
    // Chunking page processing to limit parallel Gemini calls
    for (let i = 0; i < pageIndices.length; i += concurrency) {
      const chunk = pageIndices.slice(i, i + concurrency);
      
      await Promise.all(chunk.map(async (pageIdx) => {
        const pageNum = pageIdx + 1;
        const pageText = pagesText[pageIdx];
        
        try {
          // Perform extraction with retry mechanics (up to 3 times)
          let retries = 3;
          let res: any = null;
          let lastErr: any = null;
          
          while (retries > 0) {
            try {
              res = await parsePageRows(pageText, pageNum, jobId, job!.carrier_hint || 'Unspecified');
              break;
            } catch (err: any) {
              lastErr = err;
              retries--;
              if (retries > 0) {
                // Exponential backoff delay
                const delay = Math.pow(2, 3 - retries) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
          }

          if (!res) {
            throw lastErr || new Error('Extraction failed after max retries.');
          }

          const { rows, tokensInput, tokensOutput } = res;
          
          // Accumulate tokens
          inputTokens += tokensInput;
          outputTokens += tokensOutput;

          // Insert extracted rows in batches
          if (rows.length > 0) {
            await db.insertFeeScheduleRows(rows);
            totalExtractedRows += rows.length;
          }

          // Create page-level progress record
          const progress: ParseJobProgress = {
            job_id: jobId,
            page_number: pageNum,
            status: rows.length > 0 ? 'parsed' : 'parsed', // standard parsed state
            rows_extracted: rows.length,
            error: null,
            parsed_at: new Date().toISOString()
          };

          await db.addJobProgress(progress);
          emitPageProgress(jobId, progress);
        } catch (err: any) {
          console.error(`[QUEUE ERROR] Failed to parse page ${pageNum}:`, err.message);
          
          const progress: ParseJobProgress = {
            job_id: jobId,
            page_number: pageNum,
            status: 'failed',
            rows_extracted: 0,
            error: err.message || 'Unknown extraction error',
            parsed_at: new Date().toISOString()
          };

          await db.addJobProgress(progress);
          emitPageProgress(jobId, progress);
        } finally {
          completedPages++;
          
          // Incrementally update running counts in job table
          job!.row_count = totalExtractedRows;
          await db.updateJob(jobId, {
            row_count: totalExtractedRows,
            gemini_input_tokens: Math.round(inputTokens),
            gemini_output_tokens: Math.round(outputTokens)
          });
          emitJobProgress(jobId, job!);
        }
      }));
    }

    // 4. Job Completed Successfully
    const duration = Date.now() - startTime;
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    job.duration_ms = duration;
    job.row_count = totalExtractedRows;
    job.gemini_input_tokens = Math.round(inputTokens);
    job.gemini_output_tokens = Math.round(outputTokens);

    await db.updateJob(jobId, {
      status: 'completed',
      completed_at: job.completed_at,
      duration_ms: duration,
      row_count: totalExtractedRows,
      gemini_input_tokens: job.gemini_input_tokens,
      gemini_output_tokens: job.gemini_output_tokens
    });
    
    console.log(`[QUEUE] Job ${jobId} finished. Total duration: ${duration}ms, rows: ${totalExtractedRows}`);
    emitJobProgress(jobId, job);
  } catch (err: any) {
    console.error(`[QUEUE ERROR] Critical error running job ${jobId}:`, err);
    
    // 5. Job Failed
    const duration = Date.now() - startTime;
    job.status = 'failed';
    job.completed_at = new Date().toISOString();
    job.duration_ms = duration;
    job.error_summary = err.message || 'Critical pipeline exception';

    await db.updateJob(jobId, {
      status: 'failed',
      completed_at: job.completed_at,
      duration_ms: duration,
      error_summary: job.error_summary
    });
    emitJobProgress(jobId, job);
  } finally {
    activeJobs.delete(jobId);
    
    // Clean up temp downloaded file if it exists
    const localPath = path.join(__dirname, '..', 'uploads', `${jobId}_downloaded.pdf`);
    if (fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (err: any) {
        console.error(`[QUEUE] Failed to delete temp file ${localPath}:`, err.message);
      }
    }
  }
}

// ----------------------------------------------------
// EVENT BROADCAST HELPER UTILITIES
// ----------------------------------------------------

function emitJobProgress(jobId: string, job: ParseJob) {
  queueEvents.emit('event', {
    jobId,
    type: 'job_update',
    data: job
  });
}

function emitPageProgress(jobId: string, progress: ParseJobProgress) {
  queueEvents.emit('event', {
    jobId,
    type: 'page_update',
    data: progress
  });
}
