import 'dotenv/config';
import pg from 'pg';
import { ParseJob, ParseJobProgress, FeeScheduleRow } from './types.js';

const { Pool } = pg;

// Load environment variables
const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/fee_schedule_db';

let pool: pg.Pool | null = null;
let useMemoryDb = false;

// In-Memory Database Fallback Tables
const memoryJobs: Map<string, ParseJob> = new Map();
const memoryProgress: Map<string, ParseJobProgress[]> = new Map();
const memoryRows: Map<string, FeeScheduleRow[]> = new Map();

// Helper to log with custom styling
function logDb(message: string, isError = false) {
  const reset = "\x1b[0m";
  const green = "\x1b[32m";
  const yellow = "\x1b[33m";
  const red = "\x1b[31m";
  
  if (isError) {
    console.error(`${red}[DB ERROR] ${message}${reset}`);
  } else if (useMemoryDb) {
    console.log(`${yellow}[MEMORY DB] ${message}${reset}`);
  } else {
    console.log(`${green}[POSTGRES DB] ${message}${reset}`);
  }
}

export async function initDb() {
  try {
    pool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: 5000 // 5s timeout before falling back
    });

    // Test the connection
    const client = await pool.connect();
    client.release();
    
    logDb("Successfully connected to Postgres. Running migrations...");
    await runMigrations();
  } catch (err: any) {
    useMemoryDb = true;
    pool = null;
    logDb("Could not connect to Postgres database.", true);
    logDb("⚠️ FALLING BACK TO IN-MEMORY DATABASE. Data will reset on server restart.", false);
  }
}

async function runMigrations() {
  if (!pool) return;

  const createTableQueries = [
    `CREATE TABLE IF NOT EXISTS parse_jobs (
      id UUID PRIMARY KEY,
      source_filename TEXT NOT NULL,
      blob_path TEXT NOT NULL,
      carrier_hint TEXT,
      status TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0,
      bytes BIGINT NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER,
      gemini_input_tokens BIGINT NOT NULL DEFAULT 0,
      gemini_output_tokens BIGINT NOT NULL DEFAULT 0,
      error_summary TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS parse_job_progress (
      job_id UUID REFERENCES parse_jobs(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      rows_extracted INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      parsed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_id, page_number)
    );`,
    `CREATE TABLE IF NOT EXISTS fee_schedule_rows (
      id BIGSERIAL PRIMARY KEY,
      job_id UUID REFERENCES parse_jobs(id) ON DELETE CASCADE,
      carrier TEXT NOT NULL,
      plan_name TEXT,
      effective_date DATE,
      region TEXT,
      cdt_code TEXT NOT NULL,
      procedure_desc TEXT NOT NULL,
      allowed_amount NUMERIC(12, 2) NOT NULL,
      modifier TEXT,
      source_page INTEGER NOT NULL,
      raw_row JSONB NOT NULL
    );`,
    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_fee_rows_cdt ON fee_schedule_rows(cdt_code);`,
    `CREATE INDEX IF NOT EXISTS idx_fee_rows_job ON fee_schedule_rows(job_id);`,
    `CREATE INDEX IF NOT EXISTS idx_fee_rows_carrier_cdt ON fee_schedule_rows(carrier, cdt_code);`
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const query of createTableQueries) {
      await client.query(query);
    }
    await client.query('COMMIT');
    logDb("Schema migrations applied successfully.");
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------
// DATABASE OPERATION API
// ----------------------------------------------------

export async function createJob(job: ParseJob): Promise<void> {
  if (useMemoryDb) {
    memoryJobs.set(job.id, { ...job });
    memoryProgress.set(job.id, []);
    memoryRows.set(job.id, []);
    return;
  }

  const query = `
    INSERT INTO parse_jobs (
      id, source_filename, blob_path, carrier_hint, status, 
      page_count, row_count, bytes, started_at, completed_at, 
      duration_ms, gemini_input_tokens, gemini_output_tokens, error_summary
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `;
  const params = [
    job.id, job.source_filename, job.blob_path, job.carrier_hint, job.status,
    job.page_count, job.row_count, job.bytes, job.started_at, job.completed_at,
    job.duration_ms, job.gemini_input_tokens, job.gemini_output_tokens, job.error_summary
  ];

  await pool!.query(query, params);
}

export async function getJob(id: string): Promise<ParseJob | null> {
  if (useMemoryDb) {
    const job = memoryJobs.get(id);
    return job ? { ...job } : null;
  }

  const res = await pool!.query('SELECT * FROM parse_jobs WHERE id = $1', [id]);
  if (res.rows.length === 0) return null;
  
  const r = res.rows[0];
  return {
    id: r.id,
    source_filename: r.source_filename,
    blob_path: r.blob_path,
    carrier_hint: r.carrier_hint,
    status: r.status,
    page_count: r.page_count,
    row_count: r.row_count,
    bytes: Number(r.bytes),
    started_at: r.started_at,
    completed_at: r.completed_at,
    duration_ms: r.duration_ms,
    gemini_input_tokens: Number(r.gemini_input_tokens),
    gemini_output_tokens: Number(r.gemini_output_tokens),
    error_summary: r.error_summary
  };
}

export async function getJobs(): Promise<ParseJob[]> {
  if (useMemoryDb) {
    return Array.from(memoryJobs.values()).sort((a, b) => {
      const aTime = a.started_at ? new Date(a.started_at).getTime() : 0;
      const bTime = b.started_at ? new Date(b.started_at).getTime() : 0;
      return bTime - aTime;
    });
  }

  const res = await pool!.query('SELECT * FROM parse_jobs ORDER BY started_at DESC NULLS LAST');
  return res.rows.map(r => ({
    id: r.id,
    source_filename: r.source_filename,
    blob_path: r.blob_path,
    carrier_hint: r.carrier_hint,
    status: r.status,
    page_count: r.page_count,
    row_count: r.row_count,
    bytes: Number(r.bytes),
    started_at: r.started_at,
    completed_at: r.completed_at,
    duration_ms: r.duration_ms,
    gemini_input_tokens: Number(r.gemini_input_tokens),
    gemini_output_tokens: Number(r.gemini_output_tokens),
    error_summary: r.error_summary
  }));
}

export async function updateJob(id: string, updates: Partial<ParseJob>): Promise<void> {
  if (useMemoryDb) {
    const job = memoryJobs.get(id);
    if (job) {
      memoryJobs.set(id, { ...job, ...updates });
    }
    return;
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = keys.map(k => (updates as any)[k]);
  
  await pool!.query(`UPDATE parse_jobs SET ${setClause} WHERE id = $1`, [id, ...values]);
}

export async function addJobProgress(progress: ParseJobProgress): Promise<void> {
  if (useMemoryDb) {
    const list = memoryProgress.get(progress.job_id) || [];
    // remove existing if retry updated page
    const filtered = list.filter(p => p.page_number !== progress.page_number);
    filtered.push({ ...progress });
    memoryProgress.set(progress.job_id, filtered);

    // Increment row count and status dynamically for mock
    const job = memoryJobs.get(progress.job_id);
    if (job) {
      const allRowsCount = filtered.reduce((sum, p) => sum + p.rows_extracted, 0);
      job.row_count = allRowsCount;
      memoryJobs.set(progress.job_id, job);
    }
    return;
  }

  const query = `
    INSERT INTO parse_job_progress (job_id, page_number, status, rows_extracted, error, parsed_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (job_id, page_number)
    DO UPDATE SET status = EXCLUDED.status, rows_extracted = EXCLUDED.rows_extracted, error = EXCLUDED.error, parsed_at = EXCLUDED.parsed_at
  `;
  const params = [
    progress.job_id, progress.page_number, progress.status, 
    progress.rows_extracted, progress.error, progress.parsed_at
  ];

  await pool!.query(query, params);
}

export async function getJobProgress(jobId: string): Promise<ParseJobProgress[]> {
  if (useMemoryDb) {
    return (memoryProgress.get(jobId) || []).sort((a, b) => a.page_number - b.page_number);
  }

  const res = await pool!.query('SELECT * FROM parse_job_progress WHERE job_id = $1 ORDER BY page_number ASC', [jobId]);
  return res.rows.map(r => ({
    job_id: r.job_id,
    page_number: r.page_number,
    status: r.status,
    rows_extracted: r.rows_extracted,
    error: r.error,
    parsed_at: r.parsed_at
  }));
}

export async function insertFeeScheduleRows(rows: FeeScheduleRow[]): Promise<void> {
  if (rows.length === 0) return;

  if (useMemoryDb) {
    const jobId = rows[0].job_id;
    const list = memoryRows.get(jobId) || [];
    list.push(...rows.map((r, i) => ({ ...r, id: list.length + i + 1 })));
    memoryRows.set(jobId, list);
    return;
  }

  // Multi-row INSERT inside a transaction
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    
    // We construct a query with placeholder bindings
    // Postgres supports up to 65535 parameters, so with 11 columns, we chunk into batches of 500 rows
    const columns = [
      'job_id', 'carrier', 'plan_name', 'effective_date', 
      'region', 'cdt_code', 'procedure_desc', 'allowed_amount', 
      'modifier', 'source_page', 'raw_row'
    ];

    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const valueStrings: string[] = [];
      const values: any[] = [];
      
      chunk.forEach((row, rowIndex) => {
        const offset = rowIndex * columns.length;
        const rowPlaceholders = columns.map((_, colIndex) => `$${offset + colIndex + 1}`).join(', ');
        valueStrings.push(`(${rowPlaceholders})`);
        
        values.push(
          row.job_id,
          row.carrier,
          row.plan_name,
          row.effective_date,
          row.region,
          row.cdt_code,
          row.procedure_desc,
          row.allowed_amount,
          row.modifier,
          row.source_page,
          JSON.stringify(row.raw_row)
        );
      });

      const sql = `INSERT INTO fee_schedule_rows (${columns.join(', ')}) VALUES ${valueStrings.join(', ')}`;
      await client.query(sql, values);
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getFeeScheduleRows(
  jobId: string,
  options: { page: number; limit: number; search?: string; cdtCode?: string; carrier?: string }
): Promise<{ rows: FeeScheduleRow[]; totalCount: number }> {
  const { page, limit, search, cdtCode, carrier } = options;
  const offset = (page - 1) * limit;

  if (useMemoryDb) {
    let list = memoryRows.get(jobId) || [];
    
    if (carrier) {
      list = list.filter(r => r.carrier.toLowerCase() === carrier.toLowerCase());
    }
    if (cdtCode) {
      list = list.filter(r => r.cdt_code.toLowerCase().includes(cdtCode.toLowerCase()));
    }
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(r => 
        r.cdt_code.toLowerCase().includes(s) || 
        r.procedure_desc.toLowerCase().includes(s) || 
        (r.modifier && r.modifier.toLowerCase().includes(s))
      );
    }

    const paginated = list.slice(offset, offset + limit);
    return {
      rows: paginated,
      totalCount: list.length
    };
  }

  // Construct dynamic SQL for Postgres
  const whereClauses = ['job_id = $1'];
  const params: any[] = [jobId];
  let paramIndex = 2;

  if (carrier) {
    whereClauses.push(`carrier = $${paramIndex}`);
    params.push(carrier);
    paramIndex++;
  }
  if (cdtCode) {
    whereClauses.push(`cdt_code ILIKE $${paramIndex}`);
    params.push(`%${cdtCode}%`);
    paramIndex++;
  }
  if (search) {
    whereClauses.push(`(cdt_code ILIKE $${paramIndex} OR procedure_desc ILIKE $${paramIndex} OR modifier ILIKE $${paramIndex})`);
    params.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = whereClauses.join(' AND ');
  
  // Get total count
  const countRes = await pool!.query(`SELECT COUNT(*) FROM fee_schedule_rows WHERE ${whereClause}`, params);
  const totalCount = Number(countRes.rows[0].count);

  // Get paginated rows
  const query = `
    SELECT * FROM fee_schedule_rows 
    WHERE ${whereClause} 
    ORDER BY id ASC 
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;
  params.push(limit, offset);
  
  const res = await pool!.query(query, params);
  
  return {
    rows: res.rows.map(r => ({
      id: Number(r.id),
      job_id: r.job_id,
      carrier: r.carrier,
      plan_name: r.plan_name,
      effective_date: r.effective_date ? new Date(r.effective_date).toISOString().split('T')[0] : null,
      region: r.region,
      cdt_code: r.cdt_code,
      procedure_desc: r.procedure_desc,
      allowed_amount: Number(r.allowed_amount),
      modifier: r.modifier,
      source_page: r.source_page,
      raw_row: r.raw_row
    })),
    totalCount
  };
}
