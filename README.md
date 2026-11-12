# SGA Taller

Sistema de Gestión de Almacén para un taller industrial: ubicaciones,
contenedores con QR, inventario, material restringido por proyecto,
documentación técnica y calibración de equipos.

## Estado

| Fase | Contenido | Estado |
| --- | --- | --- |
| 0 | Análisis y planificación | Completada |
| 1 | Cimientos: base de datos, login, roles, auditoría, backup | **En curso** |
| 2 | Almacén físico: ubicaciones, contenedores, QR, escáner | Pendiente |
| 3 | Inventario: entradas, retiradas, recuentos. Piloto en el taller | Pendiente |
| 4 | Proyectos y autorizaciones | Pendiente |
| 5 | Documentación y metrología | Pendiente |
| 6 | Cierre y migración a servidor online | Pendiente |

### Fase 1, paso a paso

- [x] Modelo de datos completo, con migraciones y pruebas de integridad
- [ ] API: login, sesiones, roles, permisos y auditoría
- [ ] Web: pantalla de inicio de sesión
- [ ] Proxy HTTPS
- [ ] Datos de demostración ficticios
- [ ] Backup y restauración
- [ ] Documento de instrucciones de la fase

Todavía no hay aplicación que abrir en el navegador. Lo entregado hasta ahora
es la base de datos.

## Estructura

```
apps/api/migrations   Definición de la base de datos (SQL)
apps/api/src          Código de la API
apps/api/test         Pruebas automáticas
docs                  Documentación
docker-compose.yml    Arranque del sistema
```

## Documentación

- [Modelo de datos](docs/modelo-de-datos.md)

## Tecnología

Node.js 22, TypeScript, PostgreSQL 16, React y Docker Compose.

## Para desarrolladores

Ejecutar las pruebas del modelo de datos contra un PostgreSQL vacío:

```
cd apps/api
npm ci
TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/sga_test npm test
```

Arrancar la base de datos y aplicar las migraciones con Docker:

```
cp .env.example .env      # y cambiar la contraseña
docker compose up --build
```
