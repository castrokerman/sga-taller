/**
 * Pruebas de las etiquetas QR. Además de generar el PDF, lo convierten en
 * imagen y leen el QR, para comprobar que una etiqueta impresa se puede escanear
 * y que dentro solo va el token.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jsqrModule from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { renderLabels, type LabelItem } from '../src/warehouse/labels.js';

// jsqr se publica como CommonJS: según el cargador, la función viene en .default o directamente.
type JsQR = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR: JsQR = (jsqrModule as unknown as { default?: JsQR }).default ?? (jsqrModule as unknown as JsQR);

const hasPdftoppm = spawnSync('pdftoppm', ['-v']).status === 0;

const items = (n: number): LabelItem[] =>
  Array.from({ length: n }, (_, i) => ({
    token: `FICT${String(i).padStart(4, '0')}KENABCDEFGH`.slice(0, 20),
    code: i % 2 ? `PAL-${String(i).padStart(6, '0')}` : 'ALM-A-P01-E01-N02-S01',
    title: i % 2 ? 'Palet' : 'FICTICIO Posición 1 del nivel 2',
    subtitle: i % 3 ? 'FICTICIO descripción de prueba con acentos: ñ, á, ü' : null,
  }));

/**
 * Convierte el PDF en imágenes (una por página) y lee los QR de cada una.
 * `grid` indica en cuántas columnas y filas se reparte la página: cada celda se lee por separado.
 */
function decodePages(pdf: Buffer, dpi: number, grid = { cols: 1, rows: 1 }): string[][] {
  const dir = mkdtempSync(path.join(tmpdir(), 'sga-etiquetas-'));
  writeFileSync(path.join(dir, 'e.pdf'), pdf);
  execFileSync('pdftoppm', ['-png', '-r', String(dpi), path.join(dir, 'e.pdf'), path.join(dir, 'p')]);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => {
      const png = PNG.sync.read(readFileSync(path.join(dir, f)));
      const cw = Math.floor(png.width / grid.cols);
      const ch = Math.floor(png.height / grid.rows);
      const found: string[] = [];
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          const cell = new Uint8ClampedArray(cw * ch * 4);
          for (let y = 0; y < ch; y++) {
            const start = ((row * ch + y) * png.width + col * cw) * 4;
            cell.set(png.data.subarray(start, start + cw * 4), y * cw * 4);
          }
          const hit = jsQR(cell, cw, ch);
          if (hit) found.push(hit.data);
        }
      }
      return found;
    });
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('etiquetas QR', () => {
  it('formato 6 x 4 pulgadas: una etiqueta por página', async () => {
    const pdf = await renderLabels(items(3), '4x6');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(3);
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 432 288]');
  });

  it('formato A4: 24 etiquetas por hoja', async () => {
    expect(pageCount(await renderLabels(items(24), 'a4-24'))).toBe(1);
    expect(pageCount(await renderLabels(items(25), 'a4-24'))).toBe(2);
  });

  it.skipIf(!hasPdftoppm)('el QR impreso en 6 x 4 se lee y contiene solo el token', async () => {
    const list = items(2);
    const pages = decodePages(await renderLabels(list, '4x6'), 100);
    expect(pages).toEqual([[list[0]!.token], [list[1]!.token]]);
  });

  it.skipIf(!hasPdftoppm)('los 24 QR de una hoja A4 se leen todos', async () => {
    const list = items(24);
    const [page] = decodePages(await renderLabels(list, 'a4-24'), 200, { cols: 3, rows: 8 });
    expect(page).toEqual(list.map((l) => l.token)); // todos, y en el mismo orden en que se pidieron
  });
});
