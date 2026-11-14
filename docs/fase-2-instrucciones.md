# Fase 2 · Almacén físico: instrucciones

Con esta fase el sistema ya sirve para organizar el almacén: crear las
ubicaciones, dar de alta palets y cajas, imprimir sus etiquetas QR, escanearlas
con el móvil y mover contenedores. Todavía no se registra material: eso llega
en la Fase 3.

Esta guía da por hecho que la Fase 1 ya está funcionando en tu ordenador. Si
no, empieza por [fase-1-instrucciones.md](fase-1-instrucciones.md).

## 1. Actualizar el sistema

1. Haz una copia de seguridad, por precaución. En la ventana negra, situado en
   la carpeta del proyecto:

   ```
   docker compose exec backup sh /scripts/backup.sh
   ```

2. En GitHub, acepta el pull request de la Fase 2 («Merge pull request»).
3. Descarga el ZIP nuevo (botón verde «Code», «Download ZIP») y descomprímelo
   **encima** de la carpeta actual, aceptando reemplazar los ficheros. Tu
   fichero `.env` y la carpeta `backups` no se tocan.
4. Aplica la actualización:

   ```
   docker compose up --build -d
   ```

   Tarda unos minutos. La base de datos se actualiza sola y no se pierde nada.
5. Abre `https://localhost`. Si la pantalla de inicio no muestra «Escáner QR»
   y «Almacén» activos, recarga la página con Ctrl+F5.

## 2. Qué hay de nuevo

| Pantalla | Para qué sirve | Quién la ve |
| --- | --- | --- |
| **Almacén** | Recorrer el árbol de ubicaciones y ver qué contenedores hay en cada una | Todos |
| **Ficha de contenedor** | Ver dónde está, qué lleva dentro y su historial | Todos |
| **Escáner QR** | Escanear una etiqueta y abrir su ficha | Todos |
| **Mover** | Cambiar un contenedor de sitio escaneando el destino | Todos menos consulta |
| **Etiquetas QR** | Descargar el PDF para imprimir | Todos menos consulta |
| **Crear y editar** ubicaciones y contenedores | Montar y mantener el almacén | Responsable de almacén y administrador |
| **Tipos** | Añadir tipos nuevos de ubicación y de contenedor | Administrador |

## 3. Montar el almacén

Entra con un usuario que sea responsable de almacén, por ejemplo
`demo.almacen`.

### Ubicaciones: lo que no se mueve

Las ubicaciones forman un árbol: una zona contiene pasillos, un pasillo
contiene estanterías, y así hasta la posición concreta. Los armarios y cajones
también son ubicaciones.

1. En «Almacén», pulsa «Nueva ubicación» y crea las zonas principales. Por
   ejemplo, `COM` para la zona común y `ALM-A` para el almacén principal.
2. Entra en una zona y pulsa «Nueva ubicación dentro». El sistema propone el
   código del padre como comienzo: dentro de `ALM-A` propone `ALM-A-`, y tú
   completas, por ejemplo, `ALM-A-P01`.
3. Repite hasta el nivel de detalle que necesites.

Un esquema de códigos que funciona bien:

| Código | Qué es |
| --- | --- |
| `COM` | Zona común |
| `COM-ARM-01` | Armario de líquidos |
| `ALM-A` | Almacén principal |
| `ALM-A-P01` | Pasillo 1 |
| `ALM-A-P01-E01` | Estantería 1 |
| `ALM-A-P01-E01-N02` | Nivel 2 |
| `ALM-A-P01-E01-N02-S01` | Posición 1 |

**Capacidad.** Al crear o editar una ubicación puedes indicar cuántos
contenedores admite. Si se supera, el sistema avisa y deja continuar.

**Cambiar un código** no cambia su QR: la etiqueta que ya esté pegada sigue
valiendo.

**Duplicar.** Para crear muchas ubicaciones iguales, abre una y pulsa
«Duplicar», junto a «Editar». El sistema propone el siguiente código libre
(`ALM-A-P01-E01` → `ALM-A-P01-E02`) y el nombre con el número siguiente.

- Si la ubicación tiene otras dentro, puedes marcar «Copiar también las
  ubicaciones de dentro». Una estantería con 4 niveles y 3 posiciones por nivel
  se copia entera, con los códigos cambiados: `ALM-A-P01-E01-N02-S03` pasa a
  `ALM-A-P01-E02-N02-S03`.
- Para eso, los códigos de dentro tienen que empezar por el de la ubicación
  que duplicas. Si alguno no lo hace, el sistema lo avisa y solo deja copiar
  la ubicación sola.
- Los contenedores no se copian. Las copias tienen QR nuevo.
- Puedes pulsar «Duplicar» varias veces seguidas desde el original: cada vez
  propone el siguiente código libre.

### Contenedores: lo que se mueve

1. Entra en la ubicación donde está físicamente el contenedor y pulsa «Nuevo
   contenedor aquí».
2. Elige el tipo (palet, caja, bandeja o genérico) y cuántos. El sistema les
   da código automáticamente: `PAL-000001`, `PAL-000002`…
3. Para meter cajas dentro de un palet, abre la ficha del palet y pulsa «Nuevo
   contenedor dentro».

Las cajas son desechables por defecto y los palets y bandejas reutilizables.
Se cambia en «Editar».

**Duplicar un contenedor** crea copias iguales (tipo, descripción,
responsable y política) en el mismo sitio, hasta 50 de una vez. Si lleva
otros contenedores dentro, puedes copiarlos también: se crean vacíos y con
códigos nuevos. El material nunca se copia.

### Ordenar y filtrar

Encima de cada lista de ubicaciones, contenedores o usuarios hay una barra:

- **Casilla de búsqueda:** filtra mientras escribes, sin importar tildes ni
  mayúsculas, y resalta en amarillo lo que coincide.
- **«Ordenar por»** y el botón de la flecha, que invierte el sentido. Cada
  lista recuerda en ese dispositivo el último orden elegido.
- **«Filtros»** abre filtros por campos. Por ejemplo, en contenedores: tipo,
  responsable, política y si llevan otros contenedores dentro. En ubicaciones:
  tipo y estado (vacías, con contenido o con la capacidad superada).

Cada filtro activo aparece como una etiqueta con su aspa para quitarlo, junto
al recuento («3 de 14 contenedores»).

### Vista de árbol

En la pantalla principal de «Almacén», el selector «Lista | Árbol» muestra todo
el almacén anidado.

- Cada rama se despliega o se pliega con su flecha. «Desplegar todo» y «Plegar
  todo» lo hacen de golpe.
- «Mostrar contenedores» añade los palets, cajas y bandejas, en azul, dentro de
  su ubicación.
- La búsqueda deja solo lo que coincide y el camino hasta ello, ya desplegado.
  Sirve para saber dónde está algo sin recorrer el almacén.
- Pulsar una línea abre su ficha. La vista elegida se recuerda la próxima vez.

### Exportar a Excel

En la pantalla principal de «Almacén», pulsa «Exportar a Excel» y elige
«Ubicaciones» o «Contenedores». Se descarga un fichero `.xlsx` con todo el
almacén, con la ruta completa de cada elemento y filtros en la cabecera.

Es una copia para consultar: lo que cambies en el Excel no vuelve al sistema.

## 4. Imprimir las etiquetas QR

En cualquier ubicación o contenedor, pulsa «Etiquetas QR». Se descarga un PDF.

| Formato | Cuándo usarlo |
| --- | --- |
| **6 × 4 pulgadas** | Impresora de etiquetas de rollo. Una etiqueta por página. Buena para palets y estanterías. |
| **Hoja A4 de 24 pegatinas** (70 × 37 mm) | Impresora normal, con hojas adhesivas de papelería. Buena para cajas y cajones. |

Desde una ubicación puedes imprimir de una vez su etiqueta, las de todas las
ubicaciones que contiene o las de todos sus contenedores.

**Al imprimir, elige «Tamaño real» o escala al 100 %.** Si el programa ajusta
el PDF a la página, las pegatinas de la hoja A4 salen descuadradas.

El QR solo contiene un identificador. No lleva escrito ni el sitio ni el
contenido, así que la etiqueta no hay que reimprimirla aunque el contenedor
cambie de lugar o de contenido.

## 5. Escanear y mover

### Con la cámara

1. Pulsa «Escáner QR» y apunta a una etiqueta. Se abre la ficha de esa
   ubicación o contenedor.
2. Para mover un contenedor: abre su ficha, pulsa «Mover» y escanea la etiqueta
   del destino, que puede ser una ubicación u otro contenedor.
3. Revisa el mensaje («Mover PAL-000001 a la ubicación ALM-A-P01-E02») y pulsa
   «Confirmar».

Al mover un palet se mueve todo lo que lleva dentro. Al mover una caja que
estaba dentro de un palet, sale del palet.

### Sin cámara

Debajo de la imagen de la cámara hay una casilla. Sirve para:

- **Teclear el código** legible, por ejemplo `PAL-000001`. Da igual mayúsculas
  o minúsculas.
- **Usar un lector QR USB.** Estos lectores funcionan como un teclado: haz clic
  en la casilla y dispara el lector.

En un ordenador de sobremesa sin cámara, esta es la forma normal de trabajar.

## 6. Usar el móvil

La cámara solo funciona si el móvil entra al sistema por una conexión segura
en la que confíe. Son tres pasos, y se hacen una sola vez.

### 6.1. Abrir el sistema a la red del taller

1. En el ordenador del SGA, abre la ventana negra y escribe `ipconfig`. Anota
   la «Dirección IPv4», algo como `192.168.1.50`.
2. Abre la configuración con `notepad .env` y cambia la línea `SITE_ADDRESS`:

   ```
   SITE_ADDRESS=localhost, 192.168.1.50
   ```

3. Aplica el cambio con `docker compose up -d`.
4. Si Windows pregunta por el cortafuegos, permite el acceso en redes privadas.
5. En el móvil, conectado a la wifi del taller, abre `https://192.168.1.50`
   (con tu IP).

Conviene que esa IP sea fija. Si el router la cambia, el móvil dejará de
encontrar el sistema; pide a quien gestione la red que la reserve.

### 6.2. Probar primero sin instalar nada

El navegador mostrará un aviso de conexión no privada. Pulsa «Avanzado» y
«Continuar». Entra y abre «Escáner QR».

- Si la cámara funciona, puedes dejarlo así para el piloto.
- Si no pide permiso de cámara o dice que no está disponible, sigue con el
  paso 6.3.

### 6.3. Instalar el certificado del sistema en el móvil

**La forma fácil:** en el móvil, abre `http://192.168.1.50/movil` (con tu IP,
y con `http`, sin la «s»). Es una página del propio sistema con un botón para
descargar el certificado y los pasos para iPhone y Android. En iPhone hay que
abrirla con **Safari**.

La pantalla del escáner también enlaza a esa página cuando la cámara no está
disponible.

**La forma manual**, si la anterior no funciona:

1. En el ordenador del SGA, extrae el certificado a la carpeta del proyecto:

   ```
   docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt sga-raiz.crt
   ```

2. Envía el fichero `sga-raiz.crt` al móvil, por correo o por cable.
3. Instálalo:

   | Dispositivo | Pasos |
   | --- | --- |
   | **Android** | Ajustes, «Seguridad» o «Seguridad y privacidad», «Más ajustes de seguridad», «Cifrado y credenciales», «Instalar un certificado», «Certificado de CA». Elige el fichero. Los nombres cambian según la marca; el buscador de Ajustes encuentra «certificado». |
   | **iPhone y iPad** | Abre el fichero y acepta «Permitir». Ve a Ajustes, «Perfil descargado», «Instalar». Después, Ajustes, General, Información, «Ajustes de confianza de certificados», y activa el del SGA. |
   | **Windows** | Doble clic en el fichero, «Instalar certificado», «Equipo local», «Colocar todos los certificados en el siguiente almacén», «Entidades de certificación raíz de confianza». |

4. Cierra el navegador del móvil del todo y vuelve a abrir la dirección. Ya no
   debe aparecer el aviso.

El fichero `sga-raiz.crt` no es secreto: se puede enviar por correo sin
problema.

### 6.4. Poner el icono en la pantalla del móvil

- **Android (Chrome):** menú de los tres puntos, «Añadir a pantalla de inicio»
  o «Instalar aplicación».
- **iPhone (Safari):** botón de compartir, «Añadir a pantalla de inicio».

Se abre a pantalla completa, como una aplicación más.

## 7. Qué probar

- [ ] Tras actualizar, «Escáner QR» y «Almacén» aparecen activos en el inicio.
- [ ] Crear una zona, un pasillo dentro y una estantería dentro del pasillo.
- [ ] La ruta de arriba («Almacén › ALM-A › ALM-A-P01…») permite volver atrás.
- [ ] Crear un palet en la estantería y dos cajas dentro del palet.
- [ ] Descargar las etiquetas en los dos formatos e imprimir una hoja.
- [ ] Escanear una etiqueta impresa con el móvil: se abre su ficha.
- [ ] Mover el palet a otra estantería escaneando el destino.
- [ ] Abrir una de las cajas: indica la estantería nueva y que sigue dentro del
      palet.
- [ ] Sacar una caja del palet moviéndola a otra ubicación.
- [ ] Intentar meter el palet dentro de una de sus cajas: el sistema lo impide.
- [ ] Poner capacidad 1 a una ubicación y meter dos contenedores: avisa y deja
      continuar.
- [ ] Teclear un código a mano en el escáner, por ejemplo `pal-000001`.
- [ ] Retirar una caja vacía: desaparece de las listas pero su QR la sigue
      identificando.
- [ ] Con `demo.consulta`: se puede ver todo, pero no aparecen «Mover» ni los
      botones de crear.
- [ ] Como `admin`, en «Tipos», añadir un tipo de contenedor nuevo y usarlo.
- [ ] En «Auditoría» aparecen las altas y los movimientos.
- [ ] Duplicar una estantería con sus niveles y posiciones, y comprobar los
      códigos de la copia.
- [ ] Duplicar un palet con sus cajas, pidiendo 2 copias.
- [ ] Exportar ubicaciones y contenedores a Excel y abrir los ficheros.
- [ ] Ordenar una lista por número de contenedores e invertir el orden.
- [ ] Filtrar contenedores escribiendo parte de una descripción y con un filtro
      por tipo; quitar los filtros con su aspa.
- [ ] Pasar a la vista de árbol, desplegar todo y buscar el código de una caja.
- [ ] En el móvil, abrir `http://IP/movil` e instalar el certificado.

## 8. Si algo falla

| Síntoma | Qué hacer |
| --- | --- |
| Tras actualizar, la web sigue como antes | Recarga con Ctrl+F5. Si sigue igual, comprueba que descomprimiste el ZIP encima de la carpeta correcta y repite `docker compose up --build -d`. |
| «La cámara no está disponible» | El móvil no confía en la conexión. Sigue el apartado 6.3. Mientras tanto, se puede teclear el código. |
| «No hay permiso para usar la cámara» | Se denegó el permiso. En el navegador, toca el candado junto a la dirección y permite la cámara. |
| La cámara se ve pero no lee | Acerca o aleja el móvil hasta que el QR ocupe buena parte del recuadro, y evita reflejos. Las etiquetas pequeñas se leen mejor de cerca. |
| El móvil no llega a `https://192.168.1.50` | Comprueba que está en la misma wifi, que la IP es la actual (`ipconfig`), que está en `SITE_ADDRESS` y que el cortafuegos de Windows permite el acceso. |
| Las pegatinas A4 salen descuadradas | Imprime a tamaño real, sin «Ajustar a la página». |
| «Ese código no corresponde a nada registrado» | El QR no es del SGA, o el código tecleado no existe. |

Si no se resuelve, envía el resultado de:

```
docker compose ps
docker compose logs --tail 200
```

## 9. Qué está comprobado y qué no

| Elemento | Estado |
| --- | --- |
| Ubicaciones, contenedores anidados, movimientos y retiradas | Comprobado: 26 pruebas automáticas |
| Duplicar ubicaciones y contenedores, y exportar a Excel | Comprobado: pruebas automáticas y navegador real |
| Ordenar, filtrar y vista de árbol | Comprobado con un navegador real, en escritorio y móvil |
| Página para conectar el móvil y descarga del certificado | Comprobado: el certificado descargado valida la conexión segura |
| Los QR de las etiquetas en PDF se leen, en los dos formatos | Comprobado: se genera el PDF, se convierte en imagen y se lee el QR |
| Recorrido completo en la web, en escritorio y móvil | Comprobado con un navegador real |
| Mover un contenedor escaneando una etiqueta con la cámara | Comprobado con una cámara simulada que muestra una etiqueta real |
| Actualización de una base de datos de la Fase 1 | Comprobado |
| Cámara de un móvil real, Android o iPhone | **Sin comprobar** |
| Instalación del certificado en móviles | **Sin comprobar**: los pasos son los habituales, pero los menús varían |
| Impresión en papel y lectura de la etiqueta impresa | **Sin comprobar** |
| Lector QR USB | **Sin comprobar** |
