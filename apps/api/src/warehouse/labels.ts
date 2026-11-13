import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export interface LabelItem {
  /** Lo que va dentro del QR: solo el token. */
  token: string;
  /** Código legible, en grande. */
  code: string;
  /** Segunda línea: nombre de la ubicación o tipo de contenedor. */
  title: string;
  /** Tercera línea opcional: descripción. */
  subtitle?: string | null;
}

export type LabelFormat = '4x6' | 'a4-24';

const MM = 72 / 25.4; // puntos por milímetro
const INCH = 72;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dibuja el QR como rectángulos vectoriales: nítido a cualquier tamaño de impresión. */
function drawQr(doc: PDFKit.PDFDocument, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 2; // margen blanco, en módulos
  const cell = size / (n + quiet * 2);
  doc.save().fillColor('#000000');
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.modules.data[row * n + col]) {
        // Un pelín de solape evita líneas blancas finas entre módulos.
        doc.rect(x + (col + quiet) * cell, y + (row + quiet) * cell, cell + 0.05, cell + 0.05).fill();
      }
    }
  }
  doc.restore();
}

/** Reduce el tamaño de letra hasta que el texto quepa en el ancho disponible. */
function fitFontSize(doc: PDFKit.PDFDocument, text: string, font: string, max: number, min: number, width: number): number {
  let size = max;
  doc.font(font);
  while (size > min && doc.fontSize(size).widthOfString(text) > width) size -= 0.5;
  return size;
}

/** Recorta el texto con puntos suspensivos si no cabe en el ancho disponible. */
function truncate(doc: PDFKit.PDFDocument, text: string, font: string, size: number, width: number): string {
  doc.font(font).fontSize(size);
  if (doc.widthOfString(text) <= width) return text;
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(`${cut}…`) > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Parte un código largo en dos líneas por el guion más cercano al centro. */
function splitCode(code: string): [string, string] | null {
  const hyphens = [...code].flatMap((ch, i) => (ch === '-' ? [i] : []));
  if (hyphens.length === 0) return null;
  const middle = code.length / 2;
  const at = hyphens.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best));
  return [code.slice(0, at + 1), code.slice(at + 1)];
}

function drawLabel(doc: PDFKit.PDFDocument, item: LabelItem, box: Box, scale: { code: number; title: number; small: number }) {
  const pad = Math.min(box.w, box.h) * 0.07;
  const qrSize = Math.min(box.h - pad * 2, box.w * 0.46);
  const qrX = box.x + pad;
  const qrY = box.y + (box.h - qrSize) / 2;
  drawQr(doc, item.token, qrX, qrY, qrSize);

  const textX = qrX + qrSize + pad;
  const textW = box.x + box.w - pad - textX;

  // El código es lo que se lee de lejos: lo más grande posible, en dos líneas si es largo.
  let codeLines = [item.code];
  let codeSize = fitFontSize(doc, item.code, 'Helvetica-Bold', scale.code, scale.small, textW);
  const parts = splitCode(item.code);
  if (parts && codeSize < scale.code * 0.6) {
    const longest = parts[0].length >= parts[1].length ? parts[0] : parts[1];
    const twoLineSize = fitFontSize(doc, longest, 'Helvetica-Bold', scale.code, scale.small, textW);
    if (twoLineSize > codeSize) {
      codeLines = parts;
      codeSize = twoLineSize;
    }
  }

  const lines: Array<{ text: string; font: string; size: number; gap: number }> = codeLines.map((text, i) => ({
    text, font: 'Helvetica-Bold', size: codeSize, gap: i === codeLines.length - 1 ? scale.title * 0.5 : 0,
  }));
  lines.push({
    text: truncate(doc, item.title, 'Helvetica', scale.title, textW), font: 'Helvetica', size: scale.title,
    gap: scale.small * 0.4,
  });
  if (item.subtitle) {
    lines.push({
      text: truncate(doc, item.subtitle, 'Helvetica', scale.small, textW), font: 'Helvetica', size: scale.small, gap: 0,
    });
  }

  const total = lines.reduce((sum, l, i) => sum + l.size * 1.15 + (i < lines.length - 1 ? l.gap : 0), 0);
  let y = box.y + (box.h - total) / 2;
  doc.fillColor('#000000');
  for (const l of lines) {
    doc.font(l.font).fontSize(l.size).text(l.text, textX, y, { lineBreak: false });
    y += l.size * 1.15 + l.gap;
  }
}

/**
 * Genera el PDF de etiquetas.
 *   - '4x6'   : una etiqueta por página de 6 x 4 pulgadas (impresoras de etiquetas).
 *   - 'a4-24' : hojas A4 de 24 pegatinas de 70 x 37 mm (3 columnas por 8 filas).
 */
export function renderLabels(items: LabelItem[], format: LabelFormat): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      info: { Title: 'Etiquetas SGA', Creator: 'SGA Taller' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (format === '4x6') {
      const w = 6 * INCH;
      const h = 4 * INCH;
      for (const item of items) {
        doc.addPage({ size: [w, h], margin: 0 });
        drawLabel(doc, item, { x: 0, y: 0, w, h }, { code: 44, title: 20, small: 13 });
      }
    } else {
      const cols = 3;
      const rows = 8;
      const lw = 70 * MM;
      const lh = 37 * MM;
      const pageW = 210 * MM;
      const pageH = 297 * MM;
      const top = (pageH - rows * lh) / 2;
      items.forEach((item, i) => {
        const slot = i % (cols * rows);
        if (slot === 0) doc.addPage({ size: [pageW, pageH], margin: 0 });
        const box = { x: (slot % cols) * lw, y: top + Math.floor(slot / cols) * lh, w: lw, h: lh };
        drawLabel(doc, item, box, { code: 13, title: 8, small: 6.5 });
      });
    }
    doc.end();
  });
}
