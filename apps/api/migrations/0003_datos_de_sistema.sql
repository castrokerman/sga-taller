-- =============================================================================
-- SGA Taller · Migración 0003 · Datos de sistema
--
-- Solo datos que el sistema necesita para funcionar: roles, permisos, tipos,
-- unidades y parámetros. No contiene usuarios ni datos de demostración.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
INSERT INTO role (code, name, description, is_system) VALUES
    ('ADMIN_TECNICO', 'Administrador técnico',   'Gestiona el sistema, los usuarios y los datos maestros. No aprueba material restringido por tener este rol.', true),
    ('RESP_ALMACEN',  'Responsable de almacén',  'Gestiona el almacén y todas las operaciones de inventario.', true),
    ('RESP_PROYECTO', 'Responsable de proyecto', 'Gestiona proyectos y asignaciones de material.', true),
    ('USUARIO',       'Usuario estándar',        'Consulta y realiza operaciones habituales de almacén.', true),
    ('CONSULTA',      'Usuario de consulta',     'Solo lectura.', true);

-- -----------------------------------------------------------------------------
-- Permisos
-- Aprobar retiradas restringidas NO es un permiso de rol: depende de ser
-- responsable o autorizador del proyecto (tabla project_authorizer).
-- -----------------------------------------------------------------------------
INSERT INTO permission (code, description) VALUES
    ('admin.users.manage',      'Crear, editar y desactivar usuarios'),
    ('admin.roles.manage',      'Asignar roles y permisos'),
    ('admin.parameters.manage', 'Cambiar parámetros del sistema'),
    ('admin.masterdata.manage', 'Gestionar tipos, familias y unidades'),
    ('audit.read',              'Consultar el registro de auditoría'),
    ('location.read',           'Consultar ubicaciones'),
    ('location.manage',         'Crear y editar ubicaciones'),
    ('container.read',          'Consultar contenedores'),
    ('container.manage',        'Crear, editar y retirar contenedores'),
    ('container.move',          'Mover contenedores'),
    ('material.read',           'Consultar materiales y lotes'),
    ('material.manage',         'Crear y editar materiales y lotes'),
    ('stock.read',              'Consultar stock y movimientos'),
    ('stock.receive',           'Registrar entradas'),
    ('stock.withdraw',          'Retirar material'),
    ('stock.return',            'Registrar devoluciones'),
    ('stock.transfer',          'Trasladar material entre lugares'),
    ('stock.count',             'Registrar recuentos'),
    ('stock.adjust',            'Hacer ajustes de inventario'),
    ('stock.reverse',           'Revertir movimientos'),
    ('allocation.manage',       'Asignar stock a proyectos'),
    ('request.create',          'Solicitar retiradas de material restringido'),
    ('request.read_all',        'Ver las solicitudes de todos los usuarios'),
    ('project.read',            'Consultar proyectos, clientes y líneas de negocio'),
    ('project.manage',          'Crear y editar proyectos, clientes y autorizadores'),
    ('document.read',           'Consultar y descargar documentos'),
    ('document.upload',         'Cargar documentos y versiones'),
    ('document.validate',       'Validar o rechazar documentos'),
    ('equipment.read',          'Consultar equipos y calibraciones'),
    ('equipment.manage',        'Crear y editar equipos'),
    ('calibration.record',      'Registrar calibraciones'),
    ('loan.create',             'Tomar herramientas y equipos en préstamo'),
    ('loan.manage',             'Gestionar los préstamos de todos los usuarios'),
    ('label.print',             'Generar e imprimir etiquetas QR');

-- -----------------------------------------------------------------------------
-- Permisos por rol
-- -----------------------------------------------------------------------------
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM (VALUES
    -- Lectura: todos los roles
    ('CONSULTA', 'location.read'), ('CONSULTA', 'container.read'), ('CONSULTA', 'material.read'),
    ('CONSULTA', 'stock.read'), ('CONSULTA', 'project.read'), ('CONSULTA', 'document.read'),
    ('CONSULTA', 'equipment.read'),

    ('USUARIO', 'location.read'), ('USUARIO', 'container.read'), ('USUARIO', 'material.read'),
    ('USUARIO', 'stock.read'), ('USUARIO', 'project.read'), ('USUARIO', 'document.read'),
    ('USUARIO', 'equipment.read'),
    ('USUARIO', 'container.move'), ('USUARIO', 'stock.receive'), ('USUARIO', 'stock.withdraw'),
    ('USUARIO', 'stock.return'), ('USUARIO', 'stock.transfer'), ('USUARIO', 'request.create'),
    ('USUARIO', 'document.upload'), ('USUARIO', 'loan.create'), ('USUARIO', 'label.print'),

    ('RESP_PROYECTO', 'location.read'), ('RESP_PROYECTO', 'container.read'), ('RESP_PROYECTO', 'material.read'),
    ('RESP_PROYECTO', 'stock.read'), ('RESP_PROYECTO', 'project.read'), ('RESP_PROYECTO', 'document.read'),
    ('RESP_PROYECTO', 'equipment.read'),
    ('RESP_PROYECTO', 'container.move'), ('RESP_PROYECTO', 'stock.receive'), ('RESP_PROYECTO', 'stock.withdraw'),
    ('RESP_PROYECTO', 'stock.return'), ('RESP_PROYECTO', 'stock.transfer'), ('RESP_PROYECTO', 'request.create'),
    ('RESP_PROYECTO', 'document.upload'), ('RESP_PROYECTO', 'loan.create'), ('RESP_PROYECTO', 'label.print'),
    ('RESP_PROYECTO', 'allocation.manage'), ('RESP_PROYECTO', 'request.read_all'), ('RESP_PROYECTO', 'project.manage'),

    ('RESP_ALMACEN', 'location.read'), ('RESP_ALMACEN', 'container.read'), ('RESP_ALMACEN', 'material.read'),
    ('RESP_ALMACEN', 'stock.read'), ('RESP_ALMACEN', 'project.read'), ('RESP_ALMACEN', 'document.read'),
    ('RESP_ALMACEN', 'equipment.read'),
    ('RESP_ALMACEN', 'container.move'), ('RESP_ALMACEN', 'stock.receive'), ('RESP_ALMACEN', 'stock.withdraw'),
    ('RESP_ALMACEN', 'stock.return'), ('RESP_ALMACEN', 'stock.transfer'), ('RESP_ALMACEN', 'request.create'),
    ('RESP_ALMACEN', 'document.upload'), ('RESP_ALMACEN', 'loan.create'), ('RESP_ALMACEN', 'label.print'),
    ('RESP_ALMACEN', 'location.manage'), ('RESP_ALMACEN', 'container.manage'), ('RESP_ALMACEN', 'material.manage'),
    ('RESP_ALMACEN', 'stock.count'), ('RESP_ALMACEN', 'stock.adjust'), ('RESP_ALMACEN', 'stock.reverse'),
    ('RESP_ALMACEN', 'allocation.manage'), ('RESP_ALMACEN', 'request.read_all'),
    ('RESP_ALMACEN', 'document.validate'), ('RESP_ALMACEN', 'equipment.manage'),
    ('RESP_ALMACEN', 'calibration.record'), ('RESP_ALMACEN', 'loan.manage'), ('RESP_ALMACEN', 'audit.read'),

    -- Administrador técnico: gestiona el sistema y los datos maestros.
    -- No opera inventario ni aprueba material por tener este rol.
    ('ADMIN_TECNICO', 'location.read'), ('ADMIN_TECNICO', 'container.read'), ('ADMIN_TECNICO', 'material.read'),
    ('ADMIN_TECNICO', 'stock.read'), ('ADMIN_TECNICO', 'project.read'), ('ADMIN_TECNICO', 'document.read'),
    ('ADMIN_TECNICO', 'equipment.read'),
    ('ADMIN_TECNICO', 'admin.users.manage'), ('ADMIN_TECNICO', 'admin.roles.manage'),
    ('ADMIN_TECNICO', 'admin.parameters.manage'), ('ADMIN_TECNICO', 'admin.masterdata.manage'),
    ('ADMIN_TECNICO', 'audit.read'), ('ADMIN_TECNICO', 'location.manage'), ('ADMIN_TECNICO', 'container.manage'),
    ('ADMIN_TECNICO', 'material.manage'), ('ADMIN_TECNICO', 'project.manage'), ('ADMIN_TECNICO', 'equipment.manage'),
    ('ADMIN_TECNICO', 'request.read_all'), ('ADMIN_TECNICO', 'loan.manage'), ('ADMIN_TECNICO', 'label.print')
  ) AS x (role_code, permission_code)
  JOIN role r ON r.code = x.role_code
  JOIN permission p ON p.code = x.permission_code;

-- -----------------------------------------------------------------------------
-- Tipos de ubicación y de contenedor (ampliables desde Administración)
-- -----------------------------------------------------------------------------
INSERT INTO location_type (code, name) VALUES
    ('ZONA',       'Zona'),
    ('PASILLO',    'Pasillo'),
    ('ESTANTERIA', 'Estantería'),
    ('NIVEL',      'Nivel'),
    ('POSICION',   'Posición'),
    ('ARMARIO',    'Armario'),
    ('CAJONERA',   'Cajonera'),
    ('CAJON',      'Cajón'),
    ('AREA',       'Área de trabajo');

INSERT INTO container_type (code, name, code_prefix, default_reuse_policy) VALUES
    ('PALET',    'Palet',               'PAL', 'REUSABLE'),
    ('CAJA',     'Caja',                'CAJ', 'DISPOSABLE'),
    ('BANDEJA',  'Bandeja',             'BAN', 'REUSABLE'),
    ('GENERICO', 'Contenedor genérico', 'CON', 'REUSABLE');

-- -----------------------------------------------------------------------------
-- Unidades de medida y familias de material
-- -----------------------------------------------------------------------------
INSERT INTO unit_of_measure (code, name, decimals) VALUES
    ('ud', 'Unidades',         0),
    ('m',  'Metros',           3),
    ('mm', 'Milímetros',       1),
    ('m2', 'Metros cuadrados', 3),
    ('kg', 'Kilogramos',       3),
    ('g',  'Gramos',           1),
    ('l',  'Litros',           3),
    ('ml', 'Mililitros',       1);

INSERT INTO material_family (code, name) VALUES
    ('BARRA',        'Barras metálicas'),
    ('CHAPA',        'Chapas'),
    ('BLOQUE',       'Bloques'),
    ('TORNILLERIA',  'Tornillería'),
    ('CONECTOR',     'Conectores'),
    ('HERRAMIENTA',  'Herramientas'),
    ('CONSUMIBLE',   'Consumibles'),
    ('MATERIA_PRIMA','Materias primas'),
    ('FABRICADO',    'Productos fabricados'),
    ('SEMIELABORADO','Productos semielaborados'),
    ('MEDICION',     'Equipos de medición'),
    ('REPUESTO',     'Repuestos eléctricos y mecánicos'),
    ('PROTOTIPO',    'Prototipos de proyecto'),
    ('QUIMICO',      'Líquidos y productos químicos');

-- -----------------------------------------------------------------------------
-- Tipos de documento
-- -----------------------------------------------------------------------------
INSERT INTO document_type (code, name) VALUES
    ('CERT_EN10204_31', 'Certificado EN 10204 3.1'),
    ('CERT_EN10204_32', 'Certificado EN 10204 3.2'),
    ('CERT_CONFORMIDAD','Certificado de conformidad'),
    ('CERT_PROVEEDOR',  'Certificado de proveedor'),
    ('CERT_CALIBRACION','Certificado de calibración'),
    ('INF_DIMENSIONAL', 'Informe dimensional'),
    ('INF_INSPECCION',  'Informe de inspección'),
    ('FICHA_TECNICA',   'Ficha técnica'),
    ('PLANO',           'Plano'),
    ('HOJA_SEGURIDAD',  'Hoja de seguridad'),
    ('ALBARAN',         'Albarán'),
    ('GARANTIA',        'Garantía'),
    ('DOC_FABRICACION', 'Documentación de fabricación');

-- -----------------------------------------------------------------------------
-- Parámetros del sistema (editables desde Administración)
-- -----------------------------------------------------------------------------
INSERT INTO system_parameter (key, value, description) VALUES
    ('reservation.expiry_hours',   '24',     'Horas hasta que caduca una reserva aprobada'),
    ('loan.default_days',          '14',     'Días de préstamo cuando no se indica fecha de devolución'),
    ('calibration.warning_days',   '30',     'Días de antelación para avisar de una calibración próxima'),
    ('calibration.expired_policy', '"WARN"', 'Equipo con calibración caducada: NONE (sin aviso), WARN (aviso) o BLOCK (bloqueo)'),
    ('capacity.policy',            '"WARN"', 'Capacidad superada: WARN (aviso) o BLOCK (bloqueo)'),
    ('hazard.enforce',             'true',   'Bloquear líquidos y químicos fuera de una ubicación autorizada'),
    ('session.duration_hours',     '12',     'Duración de una sesión iniciada');
