import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { badRequest } from '../errors.js';
import { renderLabels, type LabelFormat, type LabelItem } from '../warehouse/labels.js';

export function labelRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // Devuelve un PDF con las etiquetas QR de las ubicaciones y contenedores indicados,
  // en el mismo orden en que se piden.
  app.post(
    '/api/labels',
    {
      preHandler: requirePermission('label.print'),
      schema: {
        body: {
          type: 'object', required: ['items'], additionalProperties: false,
          properties: {
            format: { type: 'string', enum: ['4x6', 'a4-24'], default: '4x6' },
            items: {
              type: 'array', minItems: 1, maxItems: 240,
              items: {
                type: 'object', required: ['kind', 'id'], additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['location', 'container'] },
                  id: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { format: LabelFormat; items: Array<{ kind: 'location' | 'container'; id: string }> };
      const ids = (kind: string) => body.items.filter((i) => i.kind === kind).map((i) => i.id);

      const [locations, containers] = await Promise.all([
        pool.query(
          `SELECT l.id, l.qr_token, l.code, l.name, t.name AS type_name
             FROM storage_location l JOIN location_type t ON t.id = l.location_type_id WHERE l.id = ANY($1)`,
          [ids('location')],
        ),
        pool.query(
          `SELECT c.id, c.qr_token, c.code, c.description, t.name AS type_name
             FROM container c JOIN container_type t ON t.id = c.container_type_id WHERE c.id = ANY($1)`,
          [ids('container')],
        ),
      ]);
      const byId = new Map<string, LabelItem>();
      for (const l of locations.rows) {
        byId.set(`location:${l.id}`, { token: l.qr_token, code: l.code, title: l.name, subtitle: l.type_name });
      }
      for (const c of containers.rows) {
        byId.set(`container:${c.id}`, { token: c.qr_token, code: c.code, title: c.type_name, subtitle: c.description });
      }

      const labels = body.items.map((i) => byId.get(`${i.kind}:${i.id}`));
      if (labels.some((l) => !l)) throw badRequest('Alguno de los elementos indicados no existe', 'ELEMENTO_NO_EXISTE');

      const pdf = await renderLabels(labels as LabelItem[], body.format);
      await writeAudit(pool, {
        userId: request.user!.id, action: 'etiquetas.impresion',
        after: { formato: body.format, etiquetas: labels.length }, ip: request.ip, requestId: request.id,
      });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', 'attachment; filename="etiquetas-sga.pdf"')
        .send(pdf);
    },
  );
}
