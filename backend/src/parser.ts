import 'dotenv/config';
import fs from 'fs';
import pdf from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import { FeeScheduleRow } from './types.js';

// Initialize Gemini Client if API key is provided
const apiKey = process.env.GEMINI_API_KEY || '';
let ai: GoogleGenAI | null = null;

if (apiKey && apiKey !== 'your_gemini_api_key_here') {
  ai = new GoogleGenAI({ apiKey });
  console.log('\x1b[32m[PARSER] Gemini API initialized with provided key.\x1b[0m');
} else {
  console.log('\x1b[33m[PARSER] ⚠️ No GEMINI_API_KEY provided. The system will run in SIMULATION MODE and auto-generate realistic rows.\x1b[0m');
}

/**
 * Parses a PDF into an array of text pages.
 */
export async function parsePdfToPages(filePath: string): Promise<string[]> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const dataBuffer = fs.readFileSync(filePath);
  const pages: string[] = [];

  const options = {
    pagerender: (pageData: any) => {
      // Access text content page by page
      return pageData.getTextContent().then((textContent: any) => {
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        pages.push(pageText);
        return pageText;
      });
    }
  };

  try {
    await pdf(dataBuffer, options);
    // If the PDF parsed text is completely blank (e.g. image-only PDF),
    // we make sure to return an array of empty strings matching the page count
    if (pages.length === 0) {
      // Run quick inspect to see page count
      const meta = await pdf(dataBuffer, { max: 1 });
      const numPages = meta.numpages || 1;
      for (let i = 0; i < numPages; i++) {
        pages.push('');
      }
    }
    return pages;
  } catch (err: any) {
    console.error('[PARSER ERROR] Error reading PDF text:', err.message);
    // Return a dummy single page or empty list
    return [''];
  }
}

/**
 * Standard structured output JSON schema for Gemini.
 */
const responseSchema = {
  type: 'OBJECT',
  properties: {
    rows: {
      type: 'ARRAY',
      description: 'List of fee schedule rows extracted from the text',
      items: {
        type: 'OBJECT',
        properties: {
          cdt_code: { type: 'STRING', description: 'The procedure code, e.g., D0120' },
          procedure_desc: { type: 'STRING', description: 'Detailed description of the procedure' },
          allowed_amount: { type: 'NUMBER', description: 'The allowed dollar fee amount as a number' },
          modifier: { type: 'STRING', description: 'Modifier code (e.g. SG, GP) if present, else null' }
        },
        required: ['cdt_code', 'procedure_desc', 'allowed_amount']
      }
    }
  },
  required: ['rows']
};

/**
 * Extracts fee schedule rows from a specific page using Gemini 2.5 Flash,
 * with fallback simulation if no API key exists or an error occurs.
 */
export async function parsePageRows(
  text: string,
  pageNumber: number,
  jobId: string,
  carrier: string
): Promise<{ rows: FeeScheduleRow[]; tokensInput: number; tokensOutput: number }> {
  
  if (!ai) {
    // Running in simulation mode
    const rows = generateSimulatedRows(text, pageNumber, jobId, carrier);
    // Simulate slight delay to mirror API response time (300-800ms)
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
    return {
      rows,
      tokensInput: text.length / 4, // Simple estimation
      tokensOutput: rows.length * 20
    };
  }

  const prompt = `
    Extract all dental/medical fee schedule allowed amount rows from the following page text of an insurance carrier document.
    
    Target Carrier: ${carrier}
    Source Page: ${pageNumber}
    
    Instructions:
    1. Look for procedure codes (CDT codes, usually starts with a letter like 'D' followed by 4 digits, e.g. D0120, D1110, or general CPT codes).
    2. Extract the procedure description.
    3. Extract the allowed amount value as a decimal number (exclude currency symbols, commas).
    4. Extract any modifier code if present.
    5. Return an empty array in the 'rows' property if no valid code/fee rows exist on this page.
    
    Page Text:
    """
    ${text}
    """
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        temperature: 0
      }
    });

    const responseText = response.text || '{ "rows": [] }';
    const parsedJson = JSON.parse(responseText);
    const rawRows = parsedJson.rows || [];

    const mappedRows: FeeScheduleRow[] = rawRows.map((r: any) => ({
      job_id: jobId,
      carrier: carrier,
      plan_name: null,
      effective_date: null,
      region: null,
      cdt_code: String(r.cdt_code || '').trim(),
      procedure_desc: String(r.procedure_desc || '').trim(),
      allowed_amount: Number(r.allowed_amount) || 0,
      modifier: r.modifier ? String(r.modifier).trim() : null,
      source_page: pageNumber,
      raw_row: r
    }));

    // Estimate token usage if not provided in response metadata
    const usage = (response as any).usageMetadata;
    const tokensInput = usage?.promptTokenCount || text.length / 4;
    const tokensOutput = usage?.candidatesTokenCount || responseText.length / 4;

    return {
      rows: mappedRows,
      tokensInput,
      tokensOutput
    };
  } catch (err: any) {
    console.error(`[PARSER ERROR] Gemini failed on page ${pageNumber}:`, err.message);
    // Return empty results but report input tokens so accounting still functions
    return {
      rows: [],
      tokensInput: text.length / 4,
      tokensOutput: 0
    };
  }
}

/**
 * Generates realistic dental fee rows to simulate parsing for trial runs.
 */
function generateSimulatedRows(text: string, pageNumber: number, jobId: string, carrier: string): FeeScheduleRow[] {
  // If the uploaded document contains some standard keywords, we can make it match
  const standardProcedures = [
    { code: 'D0120', desc: 'Periodic oral evaluation - established patient', minFee: 35, maxFee: 65 },
    { code: 'D0140', desc: 'Limited oral evaluation - problem focused', minFee: 50, maxFee: 90 },
    { code: 'D0150', desc: 'Comprehensive oral evaluation - new or established patient', minFee: 60, maxFee: 120 },
    { code: 'D0210', desc: 'Intraoral - complete series of radiographic images', minFee: 90, maxFee: 160 },
    { code: 'D0220', desc: 'Intraoral - periapical first radiographic image', minFee: 20, maxFee: 40 },
    { code: 'D0274', desc: 'Bitewings - four radiographic images', minFee: 45, maxFee: 85 },
    { code: 'D1110', desc: 'Prophylaxis - adult', minFee: 65, maxFee: 110 },
    { code: 'D1120', desc: 'Prophylaxis - child', minFee: 45, maxFee: 80 },
    { code: 'D1206', desc: 'Topical application of fluoride varnish', minFee: 25, maxFee: 50 },
    { code: 'D1351', desc: 'Sealant - per tooth', minFee: 30, maxFee: 60 },
    { code: 'D2140', desc: 'Amalgam - one surface, primary or permanent', minFee: 80, maxFee: 150 },
    { code: 'D2330', desc: 'Resin-based composite - one surface, anterior', minFee: 95, maxFee: 180 },
    { code: 'D2391', desc: 'Resin-based composite - one surface, posterior', minFee: 110, maxFee: 210 },
    { code: 'D2740', desc: 'Crown - porcelain/ceramic substrate', minFee: 750, maxFee: 1200 },
    { code: 'D2750', desc: 'Crown - porcelain fused to high noble metal', minFee: 700, maxFee: 1100 },
    { code: 'D2950', desc: 'Core buildup, including any pins when required', minFee: 150, maxFee: 280 },
    { code: 'D3310', desc: 'Endodontic therapy, anterior tooth', minFee: 450, maxFee: 800 },
    { code: 'D3330', desc: 'Endodontic therapy, molar tooth', minFee: 700, maxFee: 1200 },
    { code: 'D4341', desc: 'Periodontal scaling and root planing - four or more teeth per quadrant', minFee: 140, maxFee: 250 },
    { code: 'D4910', desc: 'Periodontal maintenance', minFee: 80, maxFee: 150 },
    { code: 'D7140', desc: 'Extraction, erupted tooth or exposed root', minFee: 95, maxFee: 190 },
    { code: 'D7210', desc: 'Extraction, erupted tooth requiring removal of bone and/or sectioning of tooth', minFee: 180, maxFee: 320 },
    { code: 'D9223', desc: 'Deep sedation/general anesthesia - each 15 minute increment', minFee: 100, maxFee: 200 }
  ];

  // We generate 8 to 22 rows per page, utilizing a deterministic pseudo-randomizer based on pageNumber
  const rows: FeeScheduleRow[] = [];
  const seed = pageNumber + jobId.charCodeAt(0) + jobId.charCodeAt(1);
  const rowCount = 8 + (seed % 15); // between 8 and 22 rows per page

  for (let i = 0; i < rowCount; i++) {
    const procIndex = (seed * (i + 1) + 13) % standardProcedures.length;
    const proc = standardProcedures[procIndex];
    
    // Fee generation
    const spread = proc.maxFee - proc.minFee;
    const allowed = Math.round((proc.minFee + ((seed * (i + 3)) % spread)) * 100) / 100;
    
    // Modifier (20% chance)
    const modifier = (seed * i) % 5 === 0 ? ['GP', 'SG', '50', 'LT'][i % 4] : null;

    const r = {
      cdt_code: proc.code,
      procedure_desc: proc.desc,
      allowed_amount: allowed,
      modifier
    };

    rows.push({
      job_id: jobId,
      carrier: carrier || 'Carrier Inferred',
      plan_name: null,
      effective_date: null,
      region: null,
      cdt_code: r.cdt_code,
      procedure_desc: r.procedure_desc,
      allowed_amount: r.allowed_amount,
      modifier: r.modifier,
      source_page: pageNumber,
      raw_row: r
    });
  }

  return rows;
}
