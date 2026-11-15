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

El inicio está ordenado en bloques, y cada persona ve los suyos según sus
permisos:

| Bloque | Qué tiene | Quién lo ve |
| --- | --- | --- |
| **Día a día** | Escáner QR, Registrar entrada, Recepciones, Buscador | Todos |
| **Inventario** | Almacén, Contenidos, Préstamos, Proyectos | Todos |
| **Control** | Movimientos (solo responsables de almacén), Auditoría | Responsables de almacén y administradores |
| **Administración** | Usuarios, Tipos, Familias | Administradores |

La tarjeta de Recepciones lleva el número de pendientes. Lo que llegará en
fases posteriores aparece en una línea al final.

Para el inventario, estos son los accesos principales:

| Acceso | Para qué |
| --- | --- |
| **Contenidos** | El catálogo: qué hay (materiales, herramientas, equipos, consumibles…), cuánto en total y dónde. |
| **Movimientos** | Todo lo que ha entrado, salido o cambiado de sitio, con quién y cuándo. Solo para responsables de almacén; los demás ven el historial en la ficha de cada caja o contenido. |
| **Préstamos** | Las herramientas prestadas y hasta qué día: cada uno ve las suyas; los responsables de almacén, todas. |

Y en la ficha de cada **contenedor** y de cada **ubicación** hay una sección
nueva, **«Contenido»**, con lo que hay dentro y los botones para operar.

## 3. Preparar el catálogo

### Familias

En «Contenidos» → **«Gestionar familias»**. Ya vienen unas cuantas para
empezar: barras, chapas, tornillería, herramientas, consumibles… Puedes:

- **Crear** familias nuevas y **subfamilias** dentro de otras. Por ejemplo,
  «Tornillos» y «Tuercas y arandelas» dentro de «Tornillería».
- **Cambiar** el nombre, moverla dentro de otra o cambiar su unidad habitual.
  No afecta al stock ni al historial.
- **Borrar** una familia vacía. Si tiene materiales, se **desactiva**: deja de
  ofrecerse al dar de alta, pero sus materiales siguen igual.

### Contenidos

Todo lo que se guarda en el almacén es un **contenido**. Cada contenido es de
un **tipo**; de partida hay cuatro:

| Tipo | Código | Por defecto |
| --- | --- | --- |
| Material | `MAT-000001` | Se cuenta exacto |
| Herramienta | `HER-000002` | Se presta |
| Equipo | `EQU-000003` | Se presta |
| Consumible | `CSM-000004` | Sin contar |

El número no se repite entre tipos. El prefijo de Consumible es `CSM` y no
`CON` porque `CON` ya es el de los contenedores genéricos. Los tipos se ven y
se editan en «Tipos» (solo administradores): se pueden añadir más (por
ejemplo, Repuesto) y cambiar su prefijo. Si cambias el prefijo de un tipo, los
contenidos con código automático se recodifican; los códigos puestos a mano
se respetan. Lo mismo si cambias el tipo de un contenido: `MAT-000012` pasa a
`HER-000012`.

Al actualizar, lo que estaba marcado como prestable pasa a ser Herramienta y
su código cambia de `MAT-` a `HER-`.

**Por cantidad o por unidad.** Material y Consumible se llevan **por
cantidad**, como hasta ahora. Herramienta y Equipo se llevan **por unidad**:
cada contenido es **una sola unidad física**, con su propio código, su
**etiqueta QR** y, si se quiere, su **número de serie**. Nunca hay dos
unidades con el mismo código:

- Si entran **tres taladros iguales**, se registran tres contenidos con
  códigos seguidos (`HER-000124`, `HER-000125`, `HER-000126`), con los mismos
  datos y fotos. Al terminar sale el botón **«Etiquetas QR»** para imprimir
  la de cada uno y pegársela.
- Para prestar, sacar o trasladar una, se escanea su QR o se busca su código:
  la cantidad es siempre 1.
- En la ficha de cada unidad está **«Etiqueta QR»** para volver a imprimirla.
- Si un contenido de antes tiene varias unidades con el mismo código, su
  ficha lo avisa y ofrece **«Separar en unidades»**: se queda con una y crea
  un contenido nuevo, con su código, por cada una de las demás.

Cómo se lleva cada tipo se cambia en «Tipos» (columna «Se lleva»).

En «Contenidos» → **«+ Nuevo contenido»**. Elige el tipo: propone cómo se
cuenta y si se presta, y se puede cambiar. Lo mínimo es la descripción, la
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
- **Foto** (opcional): al crearlo se puede hacer una foto; en el móvil abre
  la cámara. Se guarda en su ficha, donde se pueden añadir más.
- **Referencia interna**: si la dejas vacía, se pone sola (MAT-000001…).
- **Duplicar**: en la ficha de un material, crea otro a partir de él. Es la
  forma rápida de dar de alta «M6x30» a partir de «M6x20».

Para dar de baja un material que ya no se usa, «Editar» → **«Dado de baja»**.
Conserva su historial.

Para cambiar muchos materiales de golpe (por ejemplo, pasar varios a otra
familia o marcarlos como prestables), usa **«Editar en tabla»** en
«Contenidos». Se explica en las instrucciones de la Fase 2, apartado «Editar
varias a la vez».

## 4. El día a día

### Registrar entrada (desde el inicio)

Es la forma más cómoda de meter material. En el inicio, **«Registrar
entrada»** te lleva en tres pasos:

1. **Material**: búscalo por nombre o referencia, o pulsa «+ Material nuevo»
   para crearlo en ese momento.
2. **Dónde**: elígelo en la lista desplegable o escanea la etiqueta. Si
   repites sitio, sale «El mismo que la última vez».
3. **Cantidad**: con lote, albarán, nota y, si quieres, **foto del
   material**, que se añade a su ficha.

Al terminar puedes seguir con **otra entrada en el mismo sitio**, con **más
del mismo material en otro sitio**, o empezar de cero.

### Cuando no sabes qué es: «Lo identifica el responsable»

Mucho de lo que llega lo ha pedido otra persona y quien lo recibe no sabe qué
es. En «Registrar entrada», elige **«Lo identifica el responsable»**:

1. **Foto**: se abre la cámara. Hasta 4 fotos; que se vea la etiqueta o el
   albarán si lo tiene.
2. **De quién es**: busca a la persona. Las últimas que has elegido salen como
   botones.
3. **Dónde lo dejas de momento**: elígelo en la lista desplegable (agrupada
   por zonas, con los contenedores de cada ubicación debajo) o escanea su
   etiqueta. También está «El mismo que la última vez».
4. Opcional: qué parece o de dónde viene, bultos y albarán.

Al pulsar «Registrar y avisar» se crea una recepción (`REC-000012`) y al
responsable le llega un aviso. En su inicio verá «Tienes una recepción por
identificar». En la recepción completa:

- **Qué es**: un material del catálogo, elegido en la lista desplegable
  (agrupada por familias), o, si no está, uno nuevo (descripción, familia,
  unidad y, si quiere, fabricante, referencia y una foto). No hace falta ser
  responsable de almacén para darlo de alta desde aquí.
- **Cantidad** y, si hace falta, **lote**.
- **Proyecto** (por ahora texto libre; propone los ya usados) y **dónde se va
  a usar**.
- **Qué se hace con ello**:
  - **Se guarda en el almacén**: donde está ahora o en otro sitio. Si es otro
    sitio, a quien lo recibió le llega el aviso «Hay que llevarlo de X a Y».
  - **Se despliega directamente**: queda registrado que entró y que salió,
    pero no queda en el inventario.
- Si quiere, usa la foto como **foto del material**.

Quien lo recibió recibe un aviso con lo identificado y lo que hay que hacer.

Si no es suyo, el responsable pulsa **«No es mío: pasárselo a otra
persona»** y le llega el aviso a la nueva. Quien la registró o un responsable
de almacén puede **anularla** con un motivo (por ejemplo, si se registró dos
veces).

**«Recepciones»**, en el inicio, muestra las pendientes con su foto, para
quién son y desde cuándo, y también las identificadas y las anuladas. Los
responsables de almacén ven todas; cada persona ve las suyas.

### Buscador (desde el inicio)

**«Buscador»** encuentra cualquier cosa escribiendo palabras, en cualquier
orden y sin importar tildes ni mayúsculas: nombre, referencia, fabricante,
lote, código de caja o de ubicación… De cada material dice **dónde está** (la
caja y la ubicación de la caja) y cuánto hay en cada sitio. Pulsar un
resultado abre su ficha.

### Desde una caja o una ubicación

**Escanea la caja o la ubicación**. En su ficha, bajo «Material», están los
botones.

### Meter material: «+ Entrada»

1. Escribe parte del nombre o la referencia y elige el material. Si no
   existe, **«+ Contenido nuevo»** lo crea en el momento (si tienes permiso).
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

En **«Préstamos»** se ven los abiertos; los que están fuera de plazo salen
en rojo. Cada persona ve **solo sus préstamos** («Tus préstamos»); los
**responsables de almacén** ven los de todos y pueden devolver en nombre de
otro. Para devolver: **«Devolver a…»** la deja en el sitio del que salió,
y **«A otro sitio»** permite escanear un sitio distinto.

### Proyectos

En el inicio, **«Proyectos»**. Los crean y editan los **responsables de
almacén**: código, nombre, responsables y, si se quiere, miembros.

- Un proyecto puede tener **varios responsables**, y una persona puede ser
  responsable de varios proyectos. El primero de la lista es el principal.
- **Los responsables** ven todo lo del proyecto en su ficha: sus contenedores,
  lo que hay dentro, sus recepciones, los préstamos de lo suyo y los últimos
  movimientos.
- **Los miembros** quedan asociados al proyecto, pero no ven todo.
- Cada persona ve en «Proyectos» solo los suyos; los responsables de almacén
  ven todos.

**Contenedores del proyecto.** En la ficha de un contenedor, **«Proyecto»**
lo asigna a un proyecto. Lo pueden hacer los responsables de almacén y los
responsables de ese proyecto. Desde ese momento, lo que hay dentro (también
en los contenedores que lleve dentro) queda **reservado**: solo lo pueden
sacar, trasladar o prestar los responsables del proyecto y los responsables
de almacén. A cualquier otro el sistema le dice para qué proyecto está
reservado. El contenedor lleva la etiqueta 🔒 con el código del proyecto.

**Recepciones para un proyecto.** Al registrar una recepción para que la
identifique el responsable, en «¿De quién es?» se puede elegir **«De un
proyecto»**. El aviso les llega a todos sus responsables y la completa
cualquiera de ellos. Al completar una recepción, el proyecto se elige de la
lista.

En «Usuarios», una columna enseña los proyectos de cada persona.

## 5. Fotos y anotaciones

En la ficha de cada **ubicación**, **contenedor** y **material** hay dos
secciones más.

### Fotos

- **«+ Añadir foto»**: en el móvil abre la cámara o la galería. Se pueden
  elegir varias de una vez.
- El propio móvil reduce la foto antes de enviarla, así que sube rápido y
  ocupa poco.
- La primera es la **principal**: sale en pequeño en las listas y en el
  catálogo. Para cambiarla, abre otra foto y pulsa «Hacer principal».
- Una foto la quita quien la subió o un responsable de almacén.
- Las fotos se guardan en la base de datos, así que entran en las copias de
  seguridad y se mudan con ella al servidor.

### Anotaciones

- **«+ Anotación»**: cualquier usuario, salvo el de consulta, puede escribir
  una nota sobre esa cosa. Por ejemplo, «el palet tiene una tabla rota».
- Cada anotación queda con **fecha, hora y quién la escribió**, y no se puede
  modificar ni borrar.
- **«Notificar a responsables»**: al marcarlo salen ya elegidas las personas
  a las que avisar:
  - en una ubicación o un material, los responsables de almacén;
  - en un contenedor, además su responsable, si lo tiene.

  Puedes quitar a alguien o pulsar «+ Avisar a otra persona». En la
  anotación queda escrito a quién se avisó.

### Avisos: la campana

Arriba, junto a tu nombre, hay una **campana** con el número de avisos sin
leer. Se actualiza sola cada minuto. Al pulsarla se ven los avisos: qué se
anotó, dónde y quién. Pulsar uno lleva a la ficha y lo marca como leído.

Los avisos por correo electrónico llegarán en la Fase 5.

## 6. La huella: nada se borra

En **«Auditoría»** (inicio, para responsables y administradores) está todo lo
que se ha hecho, sin límite: abajo, «Cargar 200 más antiguas». Se puede
filtrar por **operación** (una concreta o un grupo, como «Movimientos de
material»), por persona, por fechas y por texto (un código, una referencia…).
Pulsar una línea enseña el detalle de lo registrado.


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

## 7. Material restringido (lo que viene en la Fase 4)

En las tablas de stock aparece el **tipo de stock**: «Genérico de taller»,
«Libre · proyecto», «Restringido · proyecto» o «Restringido sin proyecto».
Por ahora todo lo que entra es genérico de taller. Asignar material a
proyectos y autorizar su retirada llega en la Fase 4. El sistema ya impide
retirar lo restringido sin autorización.

## 8. Excel

- **Contenidos** → «Exportar a Excel»: el catálogo con el total de cada uno
  y si está en stock bajo.
- **Movimientos** → «Stock a Excel»: qué hay en cada sitio, línea a línea.
- En «Almacén» → «Exportar a Excel» están los cuatro ficheros.

Es una copia para consultar: lo que cambies en el Excel no vuelve al sistema.

## 9. Qué probar

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
- [ ] Hacer una foto con el móvil a una caja y ver que sale en la lista.
- [ ] Escribir una anotación marcando «Notificar a responsables» y comprobar,
      entrando con un responsable, que le aparece en la campana.

## 10. Si algo falla

| Lo que ves | Qué hacer |
| --- | --- |
| No aparecen los botones «Retirar» o «+ Entrada» | Tu usuario no tiene permiso. El administrador técnico no opera material: añádete el rol «Responsable de almacén». |
| «Solo hay X en…» | Estás intentando sacar más de lo que dice el sistema. Si en realidad hay más, pide a un responsable un recuento. |
| «Solo X están libres; el resto está restringido…» | Parte del material es de un proyecto. Hará falta autorización (Fase 4). |
| «… exige indicar el lote» | Ese material tiene activado «Exigir lote». Escribe el lote de la etiqueta del proveedor. |
| «No se puede revertir: ese material ya se ha movido…» | Después de ese movimiento hubo otros. Corrige con una entrada o retirada nueva, o con un recuento. |
| «No se puede cambiar la unidad de un material que tiene stock» | Es a propósito, para no cambiar el sentido de lo guardado. Crea un material nuevo con la unidad correcta. |

## 11. Qué está comprobado y qué no

| Elemento | Estado |
| --- | --- |
| Entradas, retiradas, traslados, recuentos, préstamos y reversos | Comprobado: 27 pruebas automáticas nuevas sobre PostgreSQL real (143 en total) |
| Escenarios obligatorios 1, 4, 10, 15, 16 y 18 | Comprobados en esas pruebas |
| Pantallas en escritorio y móvil | Comprobadas con un navegador real, recorriendo todo el flujo |
| Actualizar una base con datos de la Fase 2 | Comprobado: la base se actualiza sola y conserva lo anterior |
| Uso real con varias personas en el taller | Pendiente: es el piloto |
| Importación desde Excel | No incluida: se parte de cero. Si hace falta una carga masiva, se añade |
