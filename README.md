# SGA Taller

Sistema de Gestión de Almacén para un taller industrial: ubicaciones,
contenedores con QR, inventario, material restringido por proyecto,
documentación técnica y calibración de equipos.

## Estado

| Fase | Contenido | Estado |
| --- | --- | --- |
| 0 | Análisis y planificación | Completada |
| 1 | Cimientos: base de datos, login, roles, auditoría, backup | Completada, pendiente de probar con Docker |
| 2 | Almacén físico: ubicaciones, contenedores, QR, escáner | Pendiente |
| 3 | Inventario: entradas, retiradas, recuentos. Piloto en el taller | Pendiente |
| 4 | Proyectos y autorizaciones | Pendiente |
| 5 | Documentación y metrología | Pendiente |
| 6 | Cierre y migración a servidor online | Pendiente |

### Fase 1, paso a paso

- [x] Modelo de datos completo, con migraciones y pruebas de integridad
- [x] API: inicio de sesión, sesiones, roles, permisos, gestión de usuarios y auditoría
- [x] Web: inicio de sesión, cambio de contraseña, inicio, usuarios y auditoría
- [x] Proxy HTTPS y Docker Compose con todos los servicios
- [x] Usuarios de demostración ficticios
- [x] Copia de seguridad diaria y restauración
- [x] Documento de instrucciones de la fase

Ya se puede entrar al sistema, gestionar usuarios y consultar la auditoría.
Las funciones de almacén llegan a partir de la Fase 2.

## Arranque

La guía paso a paso está en
[docs/fase-1-instrucciones.md](docs/fase-1-instrucciones.md). En resumen, hace
falta Docker (en Windows, Docker Desktop) y:

```
cp .env.example .env        # y cambiar las contraseñas
docker compose up --build -d
```

Después, abrir `https://localhost`. El navegador avisará de que el certificado
no es de confianza: es el certificado propio del sistema, y es lo esperado en
una instalación local. El primer administrador es el definido en `.env`, y el
sistema obliga a cambiar su contraseña al entrar.

### Qué se ha comprobado y qué no

| Elemento | Comprobado |
| --- | --- |
| Base de datos y reglas de integridad | Sí, 38 pruebas contra PostgreSQL 16 |
| API de acceso | Sí, 28 pruebas |
| Web, API y proxy HTTPS funcionando juntos | Sí, recorrido completo con un navegador real |
| Copia de seguridad y restauración sobre una base nueva | Sí, ejecutando los scripts contra PostgreSQL 16 |
| Imágenes Docker y `docker compose up` | **No.** El entorno de desarrollo no tiene Docker; se probará en el PC del taller |

## Estructura

```
apps/api/migrations   Definición de la base de datos (SQL)
apps/api/src          Código de la API
apps/api/test         Pruebas automáticas
apps/web              Interfaz web (React)
infra/proxy           Proxy HTTPS (Caddy)
infra/backup          Copias de seguridad y restauración
docs                  Documentación
docker-compose.yml    Arranque del sistema completo
```

## Documentación

- [Instrucciones de instalación y uso (Fase 1)](docs/fase-1-instrucciones.md)
- [Modelo de datos](docs/modelo-de-datos.md)

## Tecnología

Node.js 22, TypeScript, PostgreSQL 16, React y Docker Compose.

## Para desarrolladores

Pruebas, contra un PostgreSQL vacío que se pueda borrar:

```
cd apps/api
npm ci
TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/sga_test npm test
```

Desarrollo sin Docker, con dos terminales:

```
cd apps/api && DATABASE_URL=postgresql://... COOKIE_SECURE=false ADMIN_USERNAME=admin ADMIN_PASSWORD=... npm run dev
cd apps/web && npm run dev
```
