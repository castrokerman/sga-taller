import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';

interface Column {
  header: string;
  key: string;
  width: number;
  /** Formato de fecha para Excel. */
  date?: boolean;
}

/** Libro de Excel con una hoja: cabecera en negrita, fija al desplazar, y filtros. */
async function workbook(sheetName: string, columns: Column[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SGA Taller';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.header, key: c.key, width: c.width, style: c.date ? { numFmt: 'dd/mm/yyyy hh:mm' } : {},
  }));
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E6EA' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function sendXlsx(reply: FastifyReply, name: string, data: Buffer) {
  // Fecha local del servidor (TZ=Europe/Madrid en Docker), no la de Greenwich.
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', `attachment; filename="${name}-${stamp}.xlsx"`)
    .header('cache-control', 'no-store')
    .send(data);
}

export function exportRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  app.get('/api/export/ubicaciones.xlsx', { preHandler: requirePermission('location.read') }, async (request, reply) => {
    const r = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, code::text AS ruta FROM storage_location WHERE parent_id IS NULL
         UNION ALL
         SELECT l.id, tree.ruta || ' › ' || l.code FROM storage_location l JOIN tree ON l.parent_id = tree.id
       )
       SELECT l.code AS codigo, l.name AS nombre, t.name AS tipo, p.code AS superior, tree.ruta,
              l.max_capacity::int AS capacidad,
              (SELECT count(*)::int FROM container c WHERE c.location_id = l.id AND c.status = 'ACTIVE') AS contenedores,
              (SELECT count(*)::int FROM storage_location h WHERE h.parent_id = l.id AND h.active) AS ubicaciones_dentro,
              array_to_string(l.allowed_hazard_classes, ', ') AS clases_admitidas,
              l.description AS descripcion,
              CASE WHEN l.active THEN 'Sí' ELSE 'No' END AS activa,
              l.created_at AS alta
         FROM storage_location l
         JOIN location_type t ON t.id = l.location_type_id
         LEFT JOIN storage_location p ON p.id = l.parent_id
         JOIN tree ON tree.id = l.id
        ORDER BY tree.ruta`,
    );
    const data = await workbook('Ubicaciones', [
      { header: 'Código', key: 'codigo', width: 26 },
      { header: 'Nombre', key: 'nombre', width: 30 },
      { header: 'Tipo', key: 'tipo', width: 14 },
      { header: 'Ubicación superior', key: 'superior', width: 24 },
      { header: 'Ruta completa', key: 'ruta', width: 60 },
      { header: 'Capacidad (contenedores)', key: 'capacidad', width: 14 },
      { header: 'Contenedores', key: 'contenedores', width: 13 },
      { header: 'Ubicaciones dentro', key: 'ubicaciones_dentro', width: 13 },
      { header: 'Clases admitidas', key: 'clases_admitidas', width: 18 },
      { header: 'Descripción', key: 'descripcion', width: 30 },
      { header: 'Activa', key: 'activa', width: 8 },
      { header: 'Alta', key: 'alta', width: 17, date: true },
    ], r.rows);
    await writeAudit(pool, { userId: request.user!.id, action: 'exportacion.ubicaciones', after: { filas: r.rowCount }, ip: request.ip, requestId: request.id });
    return sendXlsx(reply, 'ubicaciones', data);
  });

  app.get('/api/export/contenedores.xlsx', { preHandler: requirePermission('container.read') }, async (request, reply) => {
    const r = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, code::text AS ruta FROM storage_location WHERE parent_id IS NULL
         UNION ALL
         SELECT l.id, tree.ruta || ' › ' || l.code FROM storage_location l JOIN tree ON l.parent_id = tree.id
       )
       SELECT c.code AS codigo, t.name AS tipo,
              CASE WHEN c.status = 'ACTIVE' THEN 'Activo' ELSE 'Retirado' END AS estado,
              loc.code AS ubicacion, tree.ruta, p.code AS dentro_de,
              (SELECT count(*)::int FROM container k WHERE k.parent_container_id = c.id AND k.status = 'ACTIVE') AS contenedores_dentro,
              c.description AS descripcion, u.full_name AS responsable,
              CASE WHEN c.reuse_policy = 'REUSABLE' THEN 'Reutilizable' ELSE 'Desechable' END AS politica,
              c.created_at AS alta, c.retired_at AS retirada
         FROM container c
         JOIN container_type t ON t.id = c.container_type_id
         LEFT JOIN container p ON p.id = c.parent_container_id
         LEFT JOIN container_effective_location e ON e.container_id = c.id
         LEFT JOIN storage_location loc ON loc.id = e.location_id
         LEFT JOIN tree ON tree.id = e.location_id
         LEFT JOIN app_user u ON u.id = c.responsible_user_id
        ORDER BY c.status, c.code`,
    );
    const data = await workbook('Contenedores', [
      { header: 'Código', key: 'codigo', width: 14 },
      { header: 'Tipo', key: 'tipo', width: 14 },
      { header: 'Estado', key: 'estado', width: 10 },
      { header: 'Ubicación', key: 'ubicacion', width: 26 },
      { header: 'Ruta completa', key: 'ruta', width: 60 },
      { header: 'Dentro de', key: 'dentro_de', width: 14 },
      { header: 'Contenedores dentro', key: 'contenedores_dentro', width: 13 },
      { header: 'Descripción', key: 'descripcion', width: 32 },
      { header: 'Responsable', key: 'responsable', width: 26 },
      { header: 'Política', key: 'politica', width: 13 },
      { header: 'Alta', key: 'alta', width: 17, date: true },
      { header: 'Retirada', key: 'retirada', width: 17, date: true },
    ], r.rows);
    await writeAudit(pool, { userId: request.user!.id, action: 'exportacion.contenedores', after: { filas: r.rowCount }, ip: request.ip, requestId: request.id });
    return sendXlsx(reply, 'contenedores', data);
  });

  app.get('/api/export/materiales.xlsx', { preHandler: requirePermission('material.read') }, async (request, reply) => {
    const r = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, name::text AS ruta FROM material_family WHERE parent_id IS NULL
         UNION ALL
         SELECT f.id, tree.ruta || ' › ' || f.name FROM material_family f JOIN tree ON f.parent_id = tree.id
       )
       SELECT m.internal_ref AS referencia, m.description AS descripcion, tree.ruta AS familia,
              m.manufacturer AS fabricante, m.manufacturer_ref AS ref_fabricante, m.material_spec AS material,
              m.quality_grade AS calidad, m.dimensions AS dimensiones, m.unit_code AS unidad,
              CASE m.quantity_tracking WHEN 'EXACT' THEN 'Exacto' WHEN 'ESTIMATED' THEN 'Aproximado' ELSE 'Sin contar' END AS se_cuenta,
              CASE WHEN m.quantity_tracking = 'NOT_TRACKED' THEN NULL ELSE coalesce(s.quantity, 0)::float END AS cantidad,
              s.places::int AS sitios, m.min_stock::float AS aviso_minimo,
              CASE WHEN m.min_stock IS NOT NULL AND m.quantity_tracking <> 'NOT_TRACKED' AND coalesce(s.quantity, 0) < m.min_stock
                   THEN 'Sí' ELSE '' END AS stock_bajo,
              CASE WHEN m.lot_tracked THEN 'Sí' ELSE 'No' END AS con_lote,
              CASE WHEN m.is_loanable THEN 'Sí' ELSE 'No' END AS prestable,
              CASE WHEN m.status = 'ACTIVE' THEN 'Activo' ELSE 'De baja' END AS estado,
              m.created_at AS alta
         FROM material m
         JOIN tree ON tree.id = m.family_id
         JOIN material_stock s ON s.material_id = m.id
        ORDER BY tree.ruta, m.description`,
    );
    const data = await workbook('Materiales', [
      { header: 'Referencia', key: 'referencia', width: 13 },
      { header: 'Descripción', key: 'descripcion', width: 40 },
      { header: 'Familia', key: 'familia', width: 30 },
      { header: 'Fabricante', key: 'fabricante', width: 18 },
      { header: 'Ref. fabricante', key: 'ref_fabricante', width: 18 },
      { header: 'Material', key: 'material', width: 14 },
      { header: 'Calidad', key: 'calidad', width: 12 },
      { header: 'Dimensiones', key: 'dimensiones', width: 16 },
      { header: 'Unidad', key: 'unidad', width: 8 },
      { header: 'Se cuenta', key: 'se_cuenta', width: 11 },
      { header: 'Cantidad total', key: 'cantidad', width: 13 },
      { header: 'Sitios', key: 'sitios', width: 8 },
      { header: 'Aviso si baja de', key: 'aviso_minimo', width: 12 },
      { header: 'Stock bajo', key: 'stock_bajo', width: 10 },
      { header: 'Con lote', key: 'con_lote', width: 9 },
      { header: 'Prestable', key: 'prestable', width: 10 },
      { header: 'Estado', key: 'estado', width: 9 },
      { header: 'Alta', key: 'alta', width: 17, date: true },
    ], r.rows);
    await writeAudit(pool, { userId: request.user!.id, action: 'exportacion.materiales', after: { filas: r.rowCount }, ip: request.ip, requestId: request.id });
    return sendXlsx(reply, 'materiales', data);
  });

  app.get('/api/export/stock.xlsx', { preHandler: requirePermission('stock.read') }, async (request, reply) => {
    const r = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, code::text AS ruta FROM storage_location WHERE parent_id IS NULL
         UNION ALL
         SELECT l.id, tree.ruta || ' › ' || l.code FROM storage_location l JOIN tree ON l.parent_id = tree.id
       )
       SELECT m.internal_ref AS referencia, m.description AS descripcion, f.name AS familia, lt.lot_code AS lote,
              k.code AS contenedor, coalesce(el.code, sl.code) AS ubicacion, tree.ruta,
              b.quantity::float AS cantidad, m.unit_code AS unidad,
              CASE m.quantity_tracking WHEN 'EXACT' THEN 'Exacto' WHEN 'ESTIMATED' THEN 'Aproximado' ELSE 'Sin contar (hay)' END AS se_cuenta,
              CASE WHEN b.needs_recount THEN 'Sí' ELSE '' END AS recontar,
              b.last_counted_at AS ultimo_recuento, b.updated_at AS ultimo_cambio
         FROM stock_balance b
         JOIN material m ON m.id = b.material_id
         JOIN material_family f ON f.id = m.family_id
         LEFT JOIN material_lot lt ON lt.id = b.lot_id
         LEFT JOIN container k ON k.id = b.container_id
         LEFT JOIN storage_location sl ON sl.id = b.location_id
         LEFT JOIN container_effective_location e ON e.container_id = b.container_id
         LEFT JOIN storage_location el ON el.id = e.location_id
         LEFT JOIN tree ON tree.id = coalesce(e.location_id, b.location_id)
        ORDER BY m.description, tree.ruta, k.code`,
    );
    const data = await workbook('Stock', [
      { header: 'Referencia', key: 'referencia', width: 13 },
      { header: 'Descripción', key: 'descripcion', width: 40 },
      { header: 'Familia', key: 'familia', width: 20 },
      { header: 'Lote', key: 'lote', width: 14 },
      { header: 'Contenedor', key: 'contenedor', width: 13 },
      { header: 'Ubicación', key: 'ubicacion', width: 24 },
      { header: 'Ruta completa', key: 'ruta', width: 50 },
      { header: 'Cantidad', key: 'cantidad', width: 11 },
      { header: 'Unidad', key: 'unidad', width: 8 },
      { header: 'Se cuenta', key: 'se_cuenta', width: 15 },
      { header: 'Recontar', key: 'recontar', width: 9 },
      { header: 'Último recuento', key: 'ultimo_recuento', width: 17, date: true },
      { header: 'Último cambio', key: 'ultimo_cambio', width: 17, date: true },
    ], r.rows);
    await writeAudit(pool, { userId: request.user!.id, action: 'exportacion.stock', after: { filas: r.rowCount }, ip: request.ip, requestId: request.id });
    return sendXlsx(reply, 'stock', data);
  });
}
