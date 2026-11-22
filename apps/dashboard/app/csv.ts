/** Builds a CSV file (semicolon-free, RFC 4180 quoting, UTF-8 BOM for Excel). */
export function toCsv(headers: string[], rows: string[][]): string {
  const cell = (value: string): string => {
    // Neutralize spreadsheet formulas: a cell must not start with = + - @ or a control character.
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `﻿${[headers, ...rows].map(line => line.map(cell).join(',')).join('\r\n')}\r\n`;
}

export function downloadCsv(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
