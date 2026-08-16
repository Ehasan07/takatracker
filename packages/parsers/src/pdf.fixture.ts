/**
 * A real, valid PDF built byte by byte, for the tests.
 *
 * Same reasoning as the workbook fixture next door: a checked-in binary is a
 * fixture nobody can read in a diff, and the thing that would have to be
 * trusted to tell you what is inside it is the very reader under test. Built
 * here, a test can say "these four strings are printed at these four
 * positions" and have that be a fact about the file rather than a hope.
 *
 * Deliberately plain: uncompressed content stream, one of the fourteen standard
 * fonts, WinAnsi encoding. That is exactly what a bank portal's report
 * generator emits, and it is the case worth defending.
 */

export interface PdfTextRun {
  /** Points from the left edge. */
  x: number;
  /** Points from the **bottom** edge, which is how PDF measures. */
  y: number;
  text: string;
}

/** Escape the three characters a PDF literal string cannot hold raw. */
function literal(text: string): string {
  return text.replace(/([()\\])/g, '\\$1');
}

export function makeTextPdf(runs: readonly PdfTextRun[], fontSize = 10): Buffer {
  const content =
    `BT /F1 ${fontSize} Tf\n` +
    runs.map((run) => `1 0 0 1 ${run.x} ${run.y} Tm (${literal(run.text)}) Tj`).join('\n') +
    '\nET\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
}

/**
 * A statement-shaped PDF: a letterhead, then a table.
 *
 * The letterhead is not decoration. Finding the heading row *below* four lines
 * of bank address is the thing that separates reading a PDF from reading a CSV,
 * and a fixture without one would test the easy half.
 */
export function makeStatementPdf(options: {
  preamble: readonly string[];
  header: readonly string[];
  rows: readonly (readonly string[])[];
  /** Left edge of each column, in points. */
  columns: readonly number[];
}): Buffer {
  const runs: PdfTextRun[] = [];
  let y = 780;

  for (const line of options.preamble) {
    runs.push({ x: 40, y, text: line });
    y -= 18;
  }
  y -= 12;

  for (const row of [options.header, ...options.rows]) {
    row.forEach((cell, index) => {
      if (cell !== '') runs.push({ x: options.columns[index] ?? 40, y, text: cell });
    });
    y -= 18;
  }

  return makeTextPdf(runs);
}
