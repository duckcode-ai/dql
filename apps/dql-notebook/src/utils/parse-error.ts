export interface ParsedQueryError {
  type: string;
  message: string;
  line?: number;
  near?: string;
  hint?: string;
}

export function parseQueryError(raw: string): ParsedQueryError {
  // Strip JSON wrapper if present
  let cleaned = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === 'string') {
      cleaned = parsed.error;
    }
  } catch {
    // Not JSON, use as-is
  }

  // Strip the DuckDB prefix
  cleaned = cleaned.replace(/^DuckDB query failed:\s*/i, '').trim();

  // Determine error type
  let type = 'Error';
  if (/Parser Error/i.test(cleaned)) {
    type = 'Syntax Error';
  } else if (/Binder Error/i.test(cleaned)) {
    type = 'Reference Error';
  } else if (/Conversion Error/i.test(cleaned)) {
    type = 'Type Error';
  } else if (/Invalid Input Error/i.test(cleaned)) {
    type = 'Input Error';
  } else if (/IO Error/i.test(cleaned)) {
    type = 'File Error';
  } else if (/Constraint Error/i.test(cleaned)) {
    type = 'Constraint Error';
  }

  // Extract line number
  let line: number | undefined;
  const lineMatch = cleaned.match(/LINE\s+(\d+):/i) ?? cleaned.match(/\bline\s+(\d+)\b/i);
  if (lineMatch) {
    line = parseInt(lineMatch[1], 10);
  }

  // Extract near text
  let near: string | undefined;
  const nearMatch = cleaned.match(/at or near "([^"]+)"/i);
  if (nearMatch) {
    near = nearMatch[1];
  } else if (/at end of input/i.test(cleaned)) {
    near = 'end of input';
  }

  // Build hint
  let hint: string | undefined;

  if (type === 'Syntax Error') {
    if (near === '"""' || cleaned.includes('"""')) {
      hint =
        "Triple-quoted strings are DQL block syntax. Use a DQL cell for block syntax, or plain SQL in a SQL cell.";
    } else if (near === 'end of input' || /at end of input/i.test(cleaned)) {
      hint =
        'Query is incomplete — check for unclosed parentheses, missing keywords, or a dangling comma.';
    } else if (near === ')' || near === '(') {
      hint = 'Mismatched parentheses — check that every opening ( has a closing ).';
    }
  } else if (type === 'Reference Error') {
    if (/column.*not found|Referenced column/i.test(cleaned)) {
      hint = 'Column not found — check the column name in the Schema panel (left sidebar).';
    } else if (/table.*not found|Table.*does not exist/i.test(cleaned)) {
      hint =
        "Table not found — make sure the file path is correct and the file exists in your data/ folder.";
    }
  } else if (type === 'Input Error') {
    if (/No files found/i.test(cleaned)) {
      hint =
        "File not found — use read_csv_auto('./data/filename.csv'). Open the Schema panel (left sidebar) to see all files available in your data/ folder.";
    }
  } else if (type === 'File Error') {
    hint = "File could not be read — use read_csv_auto('./data/filename.csv'). Open the Schema panel to browse available data files.";
  } else if (type === 'Type Error') {
    hint =
      'Type mismatch — you may be comparing or casting incompatible types (e.g. text vs number).';
  }

  // Clean up the message: strip the DuckDB error category prefix for display
  const message = cleaned
    .replace(/^(Parser Error|Binder Error|Conversion Error|Invalid Input Error|IO Error|Constraint Error):\s*/i, '')
    .trim();

  return { type, message, line, near, hint };
}
