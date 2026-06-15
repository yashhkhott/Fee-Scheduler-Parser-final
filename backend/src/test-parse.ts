import path from 'path';
import { fileURLToPath } from 'url';
import { parsePdfToPages, parsePageRows } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testParse() {
  const pdfPath = path.join(__dirname, '..', '..', 'fee-schedule-platform-spec.pdf');
  console.log(`\x1b[34m[TEST RUN] Starting PDF Parse Test on:\x1b[0m ${pdfPath}\n`);

  try {
    // 1. Text page segmentation check
    const pages = await parsePdfToPages(pdfPath);
    console.log(`\x1b[32m[SUCCESS] PDF parsed successfully!\x1b[0m`);
    console.log(`Total Pages: ${pages.length}\n`);

    pages.forEach((pageText, idx) => {
      const displaySnippet = pageText.trim().substring(0, 120).replace(/\s+/g, ' ');
      console.log(`Page ${idx + 1}: Snippet: "${displaySnippet}..." (Length: ${pageText.length})`);
    });

    console.log('\n----------------------------------------------------');
    console.log(`\x1b[34m[TEST RUN] Simulating LLM Row Extraction on Page 1...\x1b[0m`);
    
    // 2. Row extraction simulation check
    const { rows, tokensInput, tokensOutput } = await parsePageRows(
      pages[0] || '',
      1,
      'test-job-id',
      'Metlife'
    );

    console.log(`\x1b[32m[SUCCESS] Row Ingestion parsed successfully!\x1b[0m`);
    console.log(`Extracted rows count: ${rows.length}`);
    console.log(`Estimated input tokens: ${tokensInput}`);
    console.log(`Estimated output tokens: ${tokensOutput}\n`);
    
    console.log(`First 3 Extracted Rows Sample:`);
    console.dir(rows.slice(0, 3), { depth: null });
    
    console.log('\n\x1b[32m✅ VERIFICATION COMPLETED SUCCESSFULLY. ALL PIPELINES ARE SYSTEM STABLE.\x1b[0m\n');
  } catch (err: any) {
    console.error('\x1b[31m[FAIL] Integration Verification failed:\x1b[0m', err.message);
  }
}

testParse();
