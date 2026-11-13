# SGA Taller

Sistema de Gestión de Almacén para un taller industrial: ubicaciones,
contenedores con QR, inventario, material restringido por proyecto,
documentación técnica y calibración de equipos.

## Estado

| Fase | Contenido | Estado |
| --- | --- | --- |
| 0 | Análisis y planificación | Completada |
| 1 | Cimientos: base de datos, login, roles, auditoría, backup | Completada y arrancada con Docker en Windows |
| 2 | Almacén físico: ubicaciones, contenedores, QR, escáner | Completada, pendiente de probar con móviles reales |
| 3 | Inventario: entradas, retiradas, recuentos. Piloto en el taller | Pendiente |
| 4 | Proyectos y autorizaciones | Pendiente |
| 5 | Documentación y metrología | Pendiente |
| 6 | Cierre y migración a servidor online | Pendiente |

### Qué se puede hacer ya

- Entrar con usuario y contraseña, con cinco roles y permisos distintos.
- Montar el árbol de ubicaciones del almacén, duplicando estanterías enteras.
- Dar de alta contenedores, anidarlos y moverlos, con historial.
- Imprimir etiquetas QR en formato 6 × 4 pulgadas o en hojas A4 de 24.
- Escanear etiquetas con la cámara, con un lector USB o tecleando el código.
- Exportar ubicaciones y contenedores a Excel.
- Conectar móviles con una página de ayuda que descarga el certificado.
- Consultar la auditoría y hacer copias de seguridad.

El registro de material llega en la Fase 3.

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
| Ubicaciones, contenedores y movimientos | Sí, 26 pruebas |
| Duplicar y exportar a Excel | Sí, 18 pruebas |
| Etiquetas QR legibles en los dos formatos | Sí, 4 pruebas que leen el QR del PDF |
| Web, API y proxy HTTPS funcionando juntos | Sí, recorrido completo con un navegador real |
| Mover escaneando con la cámara | Sí, con una cámara simulada que muestra una etiqueta real |
| Copia de seguridad y restauración sobre una base nueva | Sí, ejecutando los scripts contra PostgreSQL 16 |
| Arranque con `docker compose` en Windows | Sí, en el PC del taller (Fase 1) |
| Cámara e instalación del certificado en móviles reales | **No** |
| Impresión en papel de las etiquetas | **No** |

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
- [Almacén físico, etiquetas y móviles (Fase 2)](docs/fase-2-instrucciones.md)
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
