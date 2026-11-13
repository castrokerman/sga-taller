import { describe, expect, it } from 'vitest';
import { incrementCode, incrementName, rebaseCode } from '../src/warehouse/codes.js';

describe('códigos propuestos al duplicar', () => {
  it('incrementa el último número y conserva los ceros', () => {
    expect(incrementCode('ALM-A-P01-E01')).toBe('ALM-A-P01-E02');
    expect(incrementCode('ALM-A-P01-E09')).toBe('ALM-A-P01-E10');
    expect(incrementCode('E99')).toBe('E100');
    expect(incrementCode('COM-ARM-01', 3)).toBe('COM-ARM-04');
    expect(incrementCode('ALM-A-P01-E01-N02-S01')).toBe('ALM-A-P01-E01-N02-S02');
  });

  it('sin números, añade un sufijo', () => {
    expect(incrementCode('TALLER')).toBe('TALLER-2');
    expect(incrementName('Armario de químicos')).toBe('Armario de químicos (copia)');
    expect(incrementName('Estantería 1')).toBe('Estantería 2');
  });

  it('traslada los códigos de las ubicaciones de dentro', () => {
    expect(rebaseCode('ALM-A-P01-E01-N02', 'ALM-A-P01-E01', 'ALM-A-P01-E02')).toBe('ALM-A-P01-E02-N02');
    expect(rebaseCode('OTRO-N01', 'ALM-A-P01-E01', 'ALM-A-P01-E02')).toBeNull();
  });
});
