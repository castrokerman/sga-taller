# Fase 3 · Inventario: instrucciones

Con esta fase el sistema ya sabe **qué hay dentro** de cada caja, bandeja o
ubicación, **cuánto** y **quién lo ha movido**. Es la fase con la que empieza
el piloto en el taller.

Decisiones tomadas para esta fase (14/11/2026):

- Se parte de cero: no hay un inventario anterior que importar.
- No se controlan los retales de barra o chapa. Una caja de retales es un
  material más, «sin contar».
- Las familias de material las crean y cambian los responsables de almacén y
  los administradores, y pueden tener subfamilias.
- Cualquier usuario puede retirar material, pero todo queda registrado.

## 1. Actualizar el sistema

En la ventana negra:

```
cd C:\sga-taller
docker compose exec backup sh /scripts/backup.sh && docker compose up --build -d
```

El primer comando hace una copia de seguridad y el segundo instala la versión
nueva. Al arrancar, la base de datos se actualiza sola. Todo lo que ya tenías
se conserva: usuarios, ubicaciones, contenedores y etiquetas.

### Importante: el administrador no mueve material

El rol **Administrador técnico** gestiona el sistema, pero a propósito no hace
entradas ni retiradas. Si usas ese usuario para probar, ve a «Usuarios»,
pulsa «Editar» en tu usuario y **marca también el rol «Responsable de almacén»**.
Un usuario puede tener varios roles a la vez.

## 2. Qué hay de nuevo

En el inicio aparecen tres accesos:

| Acceso | Para qué |
| --- | --- |
| **Materiales** | El catálogo: qué materiales existen, cuánto hay en total y dónde. |
| **Movimientos** | Todo lo que ha entrado, salido o cambiado de sitio, con quién y cuándo. |
| **Préstamos** | Las herramientas prestadas, a quién y hasta qué día. |

Y en la ficha de cada **contenedor** y de cada **ubicación** hay una sección
nueva, **«Material»**, con lo que hay dentro y los botones para operar.

## 3. Preparar el catálogo

### Familias

En «Materiales» → **«Gestionar familias»**. Ya vienen unas cuantas para
empezar: barras, chapas, tornillería, herramientas, consumibles… Puedes:

- **Crear** familias nuevas y **subfamilias** dentro de otras. Por ejemplo,
  «Tornillos» y «Tuercas y arandelas» dentro de «Tornillería».
- **Cambiar** el nombre, moverla dentro de otra o cambiar su unidad habitual.
  No afecta al stock ni al historial.
- **Borrar** una familia vacía. Si tiene materiales, se **desactiva**: deja de
  ofrecerse al dar de alta, pero sus materiales siguen igual.

### Materiales

En «Materiales» → **«+ Nuevo material»**. Lo mínimo es la descripción, la
familia y la unidad. Lo más importante es **cómo se cuenta**:

| Modo | Cuándo usarlo | Qué hace el sistema |
| --- | --- | --- |
| **Exacto** | Se cuenta una a una: piezas, herramientas, rodamientos… | No deja retirar más de lo que hay. |
| **Aproximado** | A ojo: tornillería a granel, cable… | Se puede retirar hasta cero. Si llega a cero, pide recontar. |
| **Sin contar** | Consumibles baratos: bridas, cinta… | Solo anota que hay y quién se lleva. |

Más opciones:

- **Avisar si baja de**: si el total queda por debajo, el material sale en
  ámbar como «Stock bajo». También se puede filtrar por ello.
- **Herramienta que se presta**: activa el botón «Prestar».
- **Exigir lote**: para material con certificado o colada. La entrada no se
  acepta sin lote.
- **Referencia interna**: si la dejas vacía, se pone sola (MAT-000001…).
- **Duplicar**: en la ficha de un material, crea otro a partir de él. Es la
  forma rápida de dar de alta «M6x30» a partir de «M6x20».

Para dar de baja un material que ya no se usa, «Editar» → **«Dado de baja»**.
Conserva su historial.

Para cambiar muchos materiales de golpe (por ejemplo, pasar varios a otra
familia o marcarlos como prestables), usa **«Editar en tabla»** en
«Materiales». Se explica en las instrucciones de la Fase 2, apartado «Editar
varias a la vez».

## 4. El día a día

Todo empieza igual: **escanea la caja o la ubicación**. En su ficha, bajo
«Material», están los botones.

### Meter material: «+ Entrada»

1. Escribe parte del nombre o la referencia y elige el material. Si no
   existe, **«+ Material nuevo»** lo crea en el momento (si tienes permiso).
2. Pon la cantidad con los botones − y + o tecleándola.
3. Opcional: lote, albarán y una nota.
4. **«Es una devolución»**: márcalo si es material que se sacó y vuelve sin
   usar. Queda registrado como devolución, no como compra.

También puedes hacer la entrada desde la ficha del material: «+ Entrada» y
después escaneas dónde lo guardas.

### Sacar material: «Retirar»

1. Si en la caja hay varios materiales, elige cuál te llevas.
2. La cantidad y, si quieres, para qué (proyecto, máquina, trabajo).
3. Antes de confirmar se ve qué quedará registrado: tu nombre, la hora y la
   cantidad.

Si una caja **desechable** se queda vacía, el sistema avisa para que la
retires con el botón «Retirar» de su ficha. No se retira sola, para que una
retirada por error se pueda deshacer.

### Cambiar de sitio: «Trasladar»

Para pasar material de una caja a otra (no la caja entera: para eso está
«Mover», de la Fase 2). Se escanea el destino y se indica cuánto.

### Contar: «Recuento»

Solo para responsables de almacén. Cuentas lo que hay de verdad y lo
escribes. Si no coincide, el sistema anota la diferencia como ajuste y lo
enseña antes de guardar. En los materiales «sin contar» solo se pregunta si
sigue habiendo.

### Prestar herramientas

En una herramienta marcada como prestable, **«Prestar»**. Por defecto se
presta a quien lo pide, y la fecha de devolución es **dentro de 14 días** si
no se indica otra. Un responsable puede prestar a otra persona.

En **«Préstamos»** se ven las abiertas; las que están fuera de plazo salen
en rojo. Para devolver: **«Devolver a…»** la deja en el sitio del que salió,
y **«A otro sitio»** permite escanear un sitio distinto.

## 5. La huella: nada se borra

- Cada operación queda como un **movimiento numerado**, con quién, cuándo,
  dónde, cuánto y para qué. No se puede modificar ni borrar.
- En la ficha de cada material está su historial completo, y en
  «Movimientos» el de todo el almacén, con búsqueda y filtros.
- **Corregir un error:** un responsable pulsa **«Revertir»** en el
  movimiento e indica el motivo. Se crea un movimiento contrario y el
  original queda marcado como «Revertido con el n.º…».
- Si el móvil pierde la cobertura justo al confirmar y se repite la
  operación, el sistema no la cuenta dos veces.
- Si dos personas sacan lo mismo a la vez, el sistema atiende a una y
  después a la otra: nunca deja el stock en negativo.

## 6. Material restringido (lo que viene en la Fase 4)

En las tablas de stock aparece el **tipo de stock**: «Genérico de taller»,
«Libre · proyecto», «Restringido · proyecto» o «Restringido sin proyecto».
Por ahora todo lo que entra es genérico de taller. Asignar material a
proyectos y autorizar su retirada llega en la Fase 4. El sistema ya impide
retirar lo restringido sin autorización.

## 7. Excel

- **Materiales** → «Exportar a Excel»: el catálogo con el total de cada uno
  y si está en stock bajo.
- **Movimientos** → «Stock a Excel»: qué hay en cada sitio, línea a línea.
- En «Almacén» → «Exportar a Excel» están los cuatro ficheros.

Es una copia para consultar: lo que cambies en el Excel no vuelve al sistema.

## 8. Qué probar

- [ ] Añadirte el rol «Responsable de almacén» si usas el administrador.
- [ ] Crear una subfamilia y un material en ella, con aviso de stock bajo.
- [ ] Escanear una caja con el móvil, hacer una entrada y luego una retirada.
- [ ] Intentar retirar más de lo que hay: el sistema no lo deja.
- [ ] Hacer una entrada creando el material en ese mismo momento.
- [ ] Trasladar parte del material a otra caja escaneándola.
- [ ] Hacer un recuento con una diferencia y ver el ajuste en el historial.
- [ ] Marcar una herramienta como prestable, prestarla y devolverla.
- [ ] Revertir un movimiento desde «Movimientos».
- [ ] Entrar como usuario estándar: puede retirar, pero no recontar ni revertir.
- [ ] Exportar materiales y stock a Excel y abrir los ficheros.

## 9. Si algo falla

| Lo que ves | Qué hacer |
| --- | --- |
| No aparecen los botones «Retirar» o «+ Entrada» | Tu usuario no tiene permiso. El administrador técnico no opera material: añádete el rol «Responsable de almacén». |
| «Solo hay X en…» | Estás intentando sacar más de lo que dice el sistema. Si en realidad hay más, pide a un responsable un recuento. |
| «Solo X están libres; el resto está restringido…» | Parte del material es de un proyecto. Hará falta autorización (Fase 4). |
| «… exige indicar el lote» | Ese material tiene activado «Exigir lote». Escribe el lote de la etiqueta del proveedor. |
| «No se puede revertir: ese material ya se ha movido…» | Después de ese movimiento hubo otros. Corrige con una entrada o retirada nueva, o con un recuento. |
| «No se puede cambiar la unidad de un material que tiene stock» | Es a propósito, para no cambiar el sentido de lo guardado. Crea un material nuevo con la unidad correcta. |

## 10. Qué está comprobado y qué no

| Elemento | Estado |
| --- | --- |
| Entradas, retiradas, traslados, recuentos, préstamos y reversos | Comprobado: 27 pruebas automáticas nuevas sobre PostgreSQL real (143 en total) |
| Escenarios obligatorios 1, 4, 10, 15, 16 y 18 | Comprobados en esas pruebas |
| Pantallas en escritorio y móvil | Comprobadas con un navegador real, recorriendo todo el flujo |
| Actualizar una base con datos de la Fase 2 | Comprobado: la base se actualiza sola y conserva lo anterior |
| Uso real con varias personas en el taller | Pendiente: es el piloto |
| Importación desde Excel | No incluida: se parte de cero. Si hace falta una carga masiva, se añade |
