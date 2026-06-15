import React, { useState, useEffect, useRef } from 'react';
import { 
  UploadCloud, 
  History, 
  LayoutDashboard, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Search, 
  Download, 
  ArrowLeft, 
  ChevronLeft, 
  ChevronRight,
  TrendingUp,
  Clock,
  Database,
  Coins
} from 'lucide-react';

// Define TS types
interface ParseJob {
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

interface ParseJobProgress {
  job_id: string;
  page_number: number;
  status: 'parsed' | 'partial' | 'failed';
  rows_extracted: number;
  error: string | null;
  parsed_at: string;
}

interface FeeScheduleRow {
  id: number;
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
}

const API_BASE = 'http://localhost:4000';

export default function App() {
  const [activeView, setActiveView] = useState<'dashboard' | 'history' | 'detail'>('dashboard');
  const [historyJobs, setHistoryJobs] = useState<ParseJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<ParseJob | null>(null);
  const [jobProgress, setJobProgress] = useState<ParseJobProgress[]>([]);
  
  // Rows Browser State
  const [rows, setRows] = useState<FeeScheduleRow[]>([]);
  const [rowsCount, setRowsCount] = useState<number>(0);
  const [rowsPage, setRowsPage] = useState<number>(1);
  const [rowsLimit] = useState<number>(15);
  const [rowsSearch, setRowsSearch] = useState<string>('');
  
  // Form Uploader State
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [carrierHint, setCarrierHint] = useState<string>('');
  const [planName, setPlanName] = useState<string>('');
  const [effectiveDate, setEffectiveDate] = useState<string>('');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [dragActive, setDragActive] = useState<boolean>(false);
  
  // Real-time SSE references
  const sseRef = useRef<EventSource | null>(null);

  // Load history list
  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/jobs`);
      if (res.ok) {
        const data = await res.json();
        setHistoryJobs(data);
      }
    } catch (err) {
      console.error('Error fetching history:', err);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  // Fetch rows when selected job changes, or search/pagination updates
  const fetchJobRows = async (jobId: string, pageNum: number, searchStr: string) => {
    try {
      const queryParams = new URLSearchParams({
        page: String(pageNum),
        limit: String(rowsLimit),
        ...(searchStr ? { search: searchStr } : {})
      });
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/rows?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows);
        setRowsCount(data.totalCount);
      }
    } catch (err) {
      console.error('Error fetching job rows:', err);
    }
  };

  useEffect(() => {
    if (selectedJobId && activeView === 'detail') {
      fetchJobRows(selectedJobId, rowsPage, rowsSearch);
    }
  }, [selectedJobId, rowsPage, rowsSearch, activeView]);

  // Connect to SSE Progress stream for selected job
  useEffect(() => {
    if (!selectedJobId || activeView !== 'detail') {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      return;
    }

    // Connect SSE
    const sse = new EventSource(`${API_BASE}/api/jobs/${selectedJobId}/progress`);
    sseRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        
        if (payload.type === 'init') {
          setSelectedJob(payload.job);
          setJobProgress(payload.progress);
        } else if (payload.type === 'job_update') {
          setSelectedJob(payload.data);
          // Refresh history list too in background
          fetchHistory();
        } else if (payload.type === 'page_update') {
          const pg: ParseJobProgress = payload.data;
          setJobProgress(prev => {
            const filtered = prev.filter(p => p.page_number !== pg.page_number);
            return [...filtered, pg].sort((a, b) => a.page_number - b.page_number);
          });
          // Refresh rows list
          fetchJobRows(selectedJobId, rowsPage, rowsSearch);
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    sse.onerror = (err) => {
      console.error('SSE connection error:', err);
      sse.close();
    };

    return () => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, [selectedJobId, activeView]);

  // Handle Drag Events
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  // Handle Drop Event
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type === "application/pdf" || file.name.endsWith('.pdf')) {
        setUploadFile(file);
      }
    }
  };

  // Handle File Input
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUploadFile(e.target.files[0]);
    }
  };

  // Start Ingest
  const handleStartIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('carrier_hint', carrierHint);
    formData.append('plan_name', planName);
    formData.append('effective_date', effectiveDate);

    try {
      const res = await fetch(`${API_BASE}/api/jobs`, {
        method: 'POST',
        body: formData
      });

      if (res.ok) {
        const job: ParseJob = await res.json();
        // Redirect to detail view
        setSelectedJobId(job.id);
        setSelectedJob(job);
        setJobProgress([]);
        setRows([]);
        setRowsPage(1);
        setRowsSearch('');
        setActiveView('detail');
        
        // Reset form
        setUploadFile(null);
        setCarrierHint('');
        setPlanName('');
        setEffectiveDate('');
        fetchHistory();
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSelectJob = (job: ParseJob) => {
    setSelectedJobId(job.id);
    setSelectedJob(job);
    setJobProgress([]);
    setRows([]);
    setRowsPage(1);
    setRowsSearch('');
    setActiveView('detail');
  };

  // Format File Size
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Format Duration
  const formatDuration = (ms: number | null) => {
    if (!ms) return '--';
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const remSec = Math.round(sec % 60);
    return `${min}m ${remSec}s`;
  };

  // Calculate Dynamic ETA
  const calculateETA = () => {
    if (!selectedJob || selectedJob.status !== 'running' || selectedJob.page_count === 0) return 'Calculating...';
    
    const parsedPages = jobProgress.length;
    if (parsedPages === 0) return 'Processing...';

    const elapsedMs = Date.now() - new Date(selectedJob.started_at!).getTime();
    const msPerPage = elapsedMs / parsedPages;
    const remainingPages = selectedJob.page_count - parsedPages;
    
    if (remainingPages <= 0) return 'Wrapping up...';
    
    const etaMs = msPerPage * remainingPages;
    const etaSec = etaMs / 1000;
    
    if (etaSec < 60) return `${Math.round(etaSec)}s remaining`;
    return `${Math.floor(etaSec / 60)}m ${Math.round(etaSec % 60)}s remaining`;
  };

  return (
    <div className="app-container">
      {/* Background ambient glows */}
      <div className="ambient-glow"></div>
      <div className="ambient-glow-right"></div>

      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div>
          <div className="brand">
            <div className="brand-icon">
              <FileText className="text-white" size={22} />
            </div>
            <h1 className="brand-name">FeeSched AI</h1>
          </div>

          <nav className="nav-menu">
            <div 
              onClick={() => setActiveView('dashboard')}
              className={`nav-item ${activeView === 'dashboard' ? 'active' : ''}`}
            >
              <LayoutDashboard className="nav-icon" />
              <span>Upload Portal</span>
            </div>
            <div 
              onClick={() => { setActiveView('history'); fetchHistory(); }}
              className={`nav-item ${activeView === 'history' || activeView === 'detail' ? 'active' : ''}`}
            >
              <Database className="nav-icon" />
              <span>Data</span>
            </div>
          </nav>
        </div>

        <div className="sidebar-footer">
          <p>Fee Schedule Ingest Platform</p>
          <p style={{ marginTop: '4px', opacity: 0.6 }}>Version 1.0.0 (AGY Stack)</p>
        </div>
      </aside>

      {/* Main dashboard body */}
      <main className="main-content">
        
        {/* VIEW 1: UPLOAD PORTAL */}
        {activeView === 'dashboard' && (
          <div>
            <div className="header-container">
              <div>
                <h2 className="header-title">PDF Ingestion Portal</h2>
                <p className="header-subtitle">Upload multi-page insurance carrier fee schedules to extract structured allowed amounts</p>
              </div>
            </div>

            <div className="glass-card accented" style={{ maxWidth: '800px', margin: '0 auto' }}>
              <form onSubmit={handleStartIngest}>
                
                {/* Drag and Drop Zone */}
                <div 
                  className={`upload-zone ${dragActive ? 'dragging' : ''}`}
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('file-input')?.click()}
                >
                  <input 
                    type="file" 
                    id="file-input" 
                    style={{ display: 'none' }} 
                    accept=".pdf"
                    onChange={handleFileChange}
                  />
                  <div className="upload-icon">
                    <UploadCloud size={30} />
                  </div>
                  {uploadFile ? (
                    <div>
                      <h4 style={{ color: '#fff', fontSize: '1.1rem' }}>{uploadFile.name}</h4>
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '6px' }}>
                        Size: {formatBytes(uploadFile.size)}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <h4 style={{ color: '#fff', fontSize: '1.1rem' }}>Drag & Drop PDF or Click to browse</h4>
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '6px' }}>
                        Supports vector and scanned dental fee schedules up to 50MB
                      </p>
                    </div>
                  )}
                </div>

                {/* Form fields overrides */}
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">Carrier Override Hint</label>
                    <select 
                      className="form-input"
                      value={carrierHint}
                      onChange={(e) => setCarrierHint(e.target.value)}
                    >
                      <option value="">Detect Automatically (AI)</option>
                      <option value="Metlife">Metlife</option>
                      <option value="Cigna">Cigna</option>
                      <option value="Aetna">Aetna</option>
                      <option value="Delta Dental">Delta Dental</option>
                      <option value="United Concordia">United Concordia</option>
                      <option value="Other">Other Carrier</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Plan Name / Network</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      placeholder="e.g. PPO Alliance"
                      value={planName}
                      onChange={(e) => setPlanName(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Effective Date</label>
                    <input 
                      type="date" 
                      className="form-input"
                      value={effectiveDate}
                      onChange={(e) => setEffectiveDate(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ marginTop: '32px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button 
                    type="submit" 
                    className="btn-primary"
                    disabled={!uploadFile || isUploading}
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="animate-spin" size={18} />
                        <span>Uploading File...</span>
                      </>
                    ) : (
                      <>
                        <UploadCloud size={18} />
                        <span>Start Ingest Pipeline</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* VIEW 2: HISTORICAL JOBS LIST */}
        {activeView === 'history' && (
          <div>
            <div className="header-container">
              <div>
                <h2 className="header-title">Fee Schedules Master Data</h2>
                <p className="header-subtitle">Select a fee schedule below to browse its details directly from the Postgres database</p>
              </div>
            </div>

            <div className="glass-card">
              <div className="table-container">
                <table className="premium-table">
                  <thead>
                    <tr>
                      <th>Filename</th>
                      <th>Carrier Hint</th>
                      <th>Pages</th>
                      <th>Rows Extracted</th>
                      <th>Token Cost</th>
                      <th>Duration</th>
                      <th>Date Ingested</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyJobs.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                          No ingestion jobs found in history. Go to the Upload Portal to add one!
                        </td>
                      </tr>
                    ) : (
                      historyJobs.map((job) => (
                        <tr 
                          key={job.id} 
                          style={{ cursor: 'pointer' }}
                          onClick={() => handleSelectJob(job)}
                        >
                          <td style={{ fontWeight: 600, color: '#fff' }}>{job.source_filename}</td>
                          <td>{job.carrier_hint || 'Auto-Inferred'}</td>
                          <td>{job.page_count || '--'}</td>
                          <td>{job.row_count.toLocaleString()}</td>
                          <td>
                            {job.gemini_input_tokens > 0 ? (
                              <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>
                                In: {Math.round(job.gemini_input_tokens / 1000)}k | Out: {Math.round(job.gemini_output_tokens / 1000)}k
                              </span>
                            ) : '--'}
                          </td>
                          <td>{formatDuration(job.duration_ms)}</td>
                          <td>{job.started_at ? new Date(job.started_at).toLocaleDateString() : '--'}</td>
                          <td>
                            <span className={`badge ${job.status}`}>
                              {job.status === 'running' && <Loader2 className="animate-spin" size={12} />}
                              {job.status === 'completed' && <CheckCircle2 size={12} />}
                              {job.status === 'failed' && <AlertCircle size={12} />}
                              {job.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 3: JOB DETAILS & REAL-TIME progress */}
        {activeView === 'detail' && selectedJob && (
          <div>
            <button 
              onClick={() => {
                // If it was completed, go to history, else stay
                setActiveView('history');
                fetchHistory();
              }}
              className="btn-secondary"
              style={{ marginBottom: '24px' }}
            >
              <ArrowLeft size={16} />
              <span>Back to Master Data</span>
            </button>

            <div className="header-container">
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <h2 className="header-title" style={{ fontSize: '1.75rem' }}>{selectedJob.source_filename}</h2>
                  <span className={`badge ${selectedJob.status}`}>
                    {selectedJob.status === 'running' && <Loader2 className="animate-spin" size={12} />}
                    {selectedJob.status}
                  </span>
                </div>
                <p className="header-subtitle">Job ID: {selectedJob.id}</p>
              </div>
              
              {selectedJob.status === 'completed' && (
                <a 
                  href={`${API_BASE}/api/jobs/${selectedJob.id}/download`}
                  className="btn-primary"
                  style={{ textDecoration: 'none' }}
                >
                  <Download size={16} />
                  <span>Download Parsed CSV</span>
                </a>
              )}
            </div>

            {/* In-Memory Warning Banner */}
            {selectedJob.gemini_input_tokens === selectedJob.row_count * 20 && selectedJob.row_count > 0 && (
              <div style={{
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.2)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '24px',
                fontSize: '0.85rem',
                color: '#f59e0b',
                display: 'flex',
                alignItems: 'center',
                gap: 10
              }}>
                <AlertCircle size={16} />
                <span><strong>Simulation Mode:</strong> This job was parsed without a live Gemini API key. Row outputs are synthetically generated for verification.</span>
              </div>
            )}

            {/* Metrics cards bar */}
            <div className="metrics-row">
              <div className="metric-card">
                <div className="metric-icon-wrap cyan">
                  <Database size={20} />
                </div>
                <div className="metric-info">
                  <span className="metric-val">{selectedJob.row_count.toLocaleString()}</span>
                  <span className="metric-lbl">Extracted Rows</span>
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-icon-wrap purple">
                  <Clock size={20} />
                </div>
                <div className="metric-info">
                  <span className="metric-val">
                    {selectedJob.status === 'running' ? calculateETA() : formatDuration(selectedJob.duration_ms)}
                  </span>
                  <span className="metric-lbl">
                    {selectedJob.status === 'running' ? 'ETA' : 'Duration'}
                  </span>
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-icon-wrap green">
                  <FileText size={20} />
                </div>
                <div className="metric-info">
                  <span className="metric-val">
                    {jobProgress.length} / {selectedJob.page_count || '?'}
                  </span>
                  <span className="metric-lbl">Pages Ingested</span>
                </div>
              </div>

              <div className="metric-card">
                <div className="metric-icon-wrap yellow">
                  <Coins size={20} />
                </div>
                <div className="metric-info">
                  <span className="metric-val">
                    {Math.round((selectedJob.gemini_input_tokens + selectedJob.gemini_output_tokens) / 1000)}k
                  </span>
                  <span className="metric-lbl">Est. Token Volume</span>
                </div>
              </div>
            </div>

            {/* Per Page progress Strip */}
            <div className="glass-card" style={{ marginTop: '24px' }}>
              <div className="page-strip-container">
                <div className="page-strip-title">
                  <span>Per-Page Parse Grid Strip (Live Stream Updates)</span>
                  <span>{Math.round((jobProgress.length / (selectedJob.page_count || 1)) * 100)}% Complete</span>
                </div>

                <div className="page-strip-grid">
                  {/* Create empty blocks matching page count if no progress yet */}
                  {Array.from({ length: selectedJob.page_count || 5 }).map((_, i) => {
                    const pageNum = i + 1;
                    const prog = jobProgress.find(p => p.page_number === pageNum);
                    
                    let blockClass = 'pending';
                    let statusLabel = 'Queued';
                    
                    if (selectedJob.status === 'running' && !prog && pageNum === jobProgress.length + 1) {
                      blockClass = 'processing';
                      statusLabel = 'Processing...';
                    } else if (prog) {
                      blockClass = prog.status;
                      statusLabel = prog.status === 'parsed' ? `${prog.rows_extracted} rows` : `Failed: ${prog.error}`;
                    }

                    return (
                      <div key={pageNum} className={`page-block ${blockClass}`}>
                        <span>{pageNum}</span>
                        <div className="tooltip">
                          <strong>Page {pageNum}</strong>: {statusLabel}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Row Search Browser Container */}
            {selectedJob.row_count > 0 && (
              <div className="glass-card" style={{ marginTop: '32px' }}>
                <div className="header-container" style={{ marginBottom: '20px' }}>
                  <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '1.25rem' }}>
                    Extracted Allowed-Fee Browser
                  </h3>
                  
                  {/* Keyword filter search */}
                  <div style={{ display: 'flex', gap: 12, width: '400px' }}>
                    <div style={{ position: 'relative', flexGrow: 1 }}>
                      <Search 
                        size={16} 
                        style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} 
                      />
                      <input 
                        type="text" 
                        className="form-input" 
                        placeholder="Search CDT code or description..." 
                        style={{ width: '100%', paddingLeft: '36px' }}
                        value={rowsSearch}
                        onChange={(e) => {
                          setRowsSearch(e.target.value);
                          setRowsPage(1); // Reset page to first
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="table-container">
                  <table className="premium-table">
                    <thead>
                      <tr>
                        <th style={{ width: '80px' }}>ID</th>
                        <th style={{ width: '120px' }}>CDT Code</th>
                        <th>Procedure Description</th>
                        <th style={{ width: '150px', textAlign: 'right' }}>Allowed Fee ($)</th>
                        <th style={{ width: '100px' }}>Modifier</th>
                        <th style={{ width: '100px', textAlign: 'center' }}>Source Page</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                            No rows matched your search filter.
                          </td>
                        </tr>
                      ) : (
                        rows.map((row) => (
                          <tr key={row.id}>
                            <td style={{ color: 'var(--text-muted)' }}>#{row.id}</td>
                            <td style={{ fontWeight: 600, color: 'var(--color-cyan)' }}>{row.cdt_code}</td>
                            <td>{row.procedure_desc}</td>
                            <td style={{ fontWeight: 600, textAlign: 'right', color: 'var(--color-success)' }}>
                              ${row.allowed_amount.toFixed(2)}
                            </td>
                            <td>
                              {row.modifier ? (
                                <span style={{ padding: '2px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', fontSize: '0.75rem' }}>
                                  {row.modifier}
                                </span>
                              ) : '--'}
                            </td>
                            <td style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Page {row.source_page}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Rows pagination control */}
                {rowsCount > rowsLimit && (
                  <div className="pagination">
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      Showing {((rowsPage - 1) * rowsLimit) + 1} - {Math.min(rowsPage * rowsLimit, rowsCount)} of {rowsCount} entries
                    </span>
                    <div className="pagination-buttons">
                      <button 
                        className="btn-secondary" 
                        style={{ padding: '6px 12px' }}
                        disabled={rowsPage === 1}
                        onClick={() => setRowsPage(prev => Math.max(1, prev - 1))}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <button 
                        className="btn-secondary" 
                        style={{ padding: '6px 12px' }}
                        disabled={rowsPage * rowsLimit >= rowsCount}
                        onClick={() => setRowsPage(prev => prev + 1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
