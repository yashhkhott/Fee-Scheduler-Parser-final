export interface ParseJob {
  id: string;
  source_filename: string;
  blob_path: string;
  carrier_hint: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  page_count: number;
  row_count: number;
  bytes: number;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  gemini_input_tokens: number;
  gemini_output_tokens: number;
  error_summary: string | null;
}

export interface ParseJobProgress {
  job_id: string;
  page_number: number;
  status: 'parsed' | 'partial' | 'failed';
  rows_extracted: number;
  error: string | null;
  parsed_at: string;
}

export interface FeeScheduleRow {
  id?: number;
  job_id: string;
  carrier: string;
  plan_name: string | null;
  effective_date: string | null;
  region: string | null;
  cdt_code: string;
  procedure_desc: string;
  allowed_amount: number;
  modifier: string | null;
  source_page: number;
  raw_row: any;
}
