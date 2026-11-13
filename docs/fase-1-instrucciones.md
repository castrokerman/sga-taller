# Fase 1 · Instrucciones de instalación y uso

Esta guía explica cómo poner en marcha el SGA en un ordenador con Windows,
cómo entrar, qué probar y cómo cuidar los datos. No hace falta saber
programar: basta con seguir los pasos en orden.

Al terminar tendrás el sistema funcionando en `https://localhost`, con inicio
de sesión, usuarios, roles y registro de auditoría. Las funciones de almacén
llegan en las fases siguientes.

> **Importante.** El arranque con Docker no se ha podido probar durante el
> desarrollo, porque el entorno donde se programó no tiene Docker. Todo lo
> demás sí está probado. Si algún paso de los apartados 4 o 5 falla, copia el
> mensaje de error y envíalo: ver el apartado 12.

## 1. Qué necesitas

- Un ordenador con Windows 10 u 11 de 64 bits y, como mínimo, 8 GB de memoria.
- Permisos de administrador en ese ordenador, para instalar Docker.
- Conexión a internet durante la instalación.
- Unos 30 minutos la primera vez.

## 2. Instalar Docker Desktop

Docker es el programa que ejecuta el sistema. Se instala una sola vez.

1. Abre <https://docs.docker.com/desktop/setup/install/windows-install/> y
   descarga «Docker Desktop for Windows».
2. Ejecuta el instalador y deja las opciones como vienen. Si pregunta por
   «WSL 2», acéptalo.
3. Reinicia el ordenador cuando lo pida.
4. Abre Docker Desktop desde el menú Inicio y acepta las condiciones. No hace
   falta crear una cuenta: se puede continuar sin iniciar sesión.
5. Espera a que abajo a la izquierda indique que el motor está en marcha
   («Engine running»).

Docker Desktop es gratuito para uso personal y para empresas pequeñas (menos
de 250 empleados y menos de 10 millones de dólares de facturación anual). Las
empresas mayores necesitan una suscripción de pago.

Docker Desktop debe estar abierto para que el SGA funcione. En sus ajustes
(«Settings», «General») puedes marcar que se inicie al encender el ordenador.

## 3. Descargar el proyecto

1. Entra en <https://github.com/castrokerman/sga-taller>.
2. Pulsa el botón verde «Code» y después «Download ZIP».
3. Descomprime el ZIP en una carpeta fácil de encontrar, por ejemplo
   `C:\sga-taller`. Dentro debes ver, entre otros, el fichero
   `docker-compose.yml`.

## 4. Configurar las contraseñas

La configuración vive en un fichero llamado `.env` que solo existe en tu
ordenador. Nunca se sube a GitHub.

1. Abre la carpeta del proyecto en el Explorador de archivos.
2. Haz clic en la barra de direcciones de la ventana, escribe `cmd` y pulsa
   Intro. Se abre una ventana negra (la terminal) situada en esa carpeta.
3. Escribe estas dos órdenes, pulsando Intro tras cada una:

   ```
   copy .env.example .env
   notepad .env
   ```

4. En el Bloc de notas, cambia estas dos líneas por contraseñas tuyas:

   | Línea | Qué es | Condiciones |
   | --- | --- | --- |
   | `POSTGRES_PASSWORD=` | Contraseña interna de la base de datos | Solo letras y números, sin espacios |
   | `ADMIN_PASSWORD=` | Contraseña provisional del primer administrador | Mínimo 10 caracteres |

5. Guarda el fichero y cierra el Bloc de notas.

Apunta las dos contraseñas en un lugar seguro. Deja el resto de líneas como
están por ahora.

## 5. Arrancar el sistema

En la misma terminal, escribe:

```
docker compose up --build -d
```

La primera vez tarda varios minutos, porque descarga y prepara todo. Cuando
termina, vuelve a mostrar la línea para escribir. Comprueba que todo está en
marcha con:

```
docker compose ps
```

Deben aparecer cuatro servicios (`db`, `api`, `proxy` y `backup`) en estado
«running» o «healthy».

## 6. Entrar por primera vez

1. Abre el navegador y ve a <https://localhost>.
2. El navegador avisará de que la conexión no es privada. Es lo esperado: el
   sistema usa un certificado propio, que tu navegador aún no conoce. Pulsa
   «Avanzado» o «Configuración avanzada» y después «Continuar a localhost».
3. Entra con el usuario `admin` y la contraseña que pusiste en
   `ADMIN_PASSWORD`.
4. El sistema te pedirá elegir una contraseña nueva. A partir de ahí, esa es
   la que vale.

## 7. Qué probar

Con `SEED_DEMO=true` (así viene) el sistema crea cuatro usuarios ficticios,
uno por rol, todos con la contraseña `demo-ficticio-2026`:

| Usuario | Rol |
| --- | --- |
| `demo.almacen` | Responsable de almacén |
| `demo.proyecto` | Responsable de proyecto |
| `demo.usuario` | Usuario estándar |
| `demo.consulta` | Usuario de consulta |

Lista de comprobación:

- [ ] Entrar como `admin` y cambiar la contraseña provisional.
- [ ] Escribir mal la contraseña: aparece «Usuario o contraseña incorrectos».
- [ ] En «Usuarios», crear un usuario nuevo con rol de usuario estándar.
- [ ] Salir, entrar con ese usuario nuevo y comprobar que obliga a cambiar la
      contraseña.
- [ ] Con ese usuario, comprobar que en el inicio no aparece «Usuarios».
- [ ] Entrar como `demo.almacen`: aparece «Auditoría» pero no «Usuarios».
- [ ] Como `admin`, desactivar un usuario y comprobar que ya no puede entrar.
- [ ] Como `admin`, restablecer la contraseña de un usuario.
- [ ] En «Auditoría», ver registradas todas las operaciones anteriores.
- [ ] Fallar la contraseña cinco veces con un usuario: queda bloqueado 15
      minutos. Se desbloquea restableciéndole la contraseña.
- [ ] Abrir el sistema en el móvil (apartado 8) y comprobar que se ve bien.

Cuando el sistema vaya a usarse con datos reales, desactiva los usuarios
`demo.*` desde «Usuarios» y pon `SEED_DEMO=false` en el fichero `.env`.

## 8. Entrar desde otros ordenadores, tablets y móviles

Por defecto solo se puede entrar desde el propio ordenador. Para abrirlo al
resto de la red del taller:

1. **Averigua la dirección IP del ordenador.** En la terminal, escribe
   `ipconfig` y busca «Dirección IPv4», algo como `192.168.1.50`. Conviene
   pedir a quien gestione la red que esa IP sea fija.
2. **Indícasela al sistema.** Abre el fichero con `notepad .env` y cambia la
   línea `SITE_ADDRESS` para que incluya la IP:

   ```
   SITE_ADDRESS=localhost, 192.168.1.50
   ```

3. **Aplica el cambio:**

   ```
   docker compose up -d
   ```

4. **Permite el acceso en el cortafuegos de Windows** si lo pregunta, para
   redes privadas.
5. Desde otro equipo de la misma red, abre `https://192.168.1.50` (con tu IP)
   y acepta el aviso del certificado igual que en el apartado 6.

### Quitar el aviso del certificado y usar la cámara del móvil

Con el aviso aceptado se puede usar la web, pero los móviles solo permiten
usar la cámara (necesaria para el escáner QR de la Fase 2) si confían en el
certificado. Para eso se instala en cada dispositivo el «certificado raíz» del
sistema:

1. Extrae el certificado a la carpeta del proyecto:

   ```
   docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt sga-raiz.crt
   ```

2. Envía el fichero `sga-raiz.crt` al dispositivo, por correo o por cable.
3. Instálalo como certificado de confianza:
   - **Windows:** doble clic, «Instalar certificado», «Equipo local», y
     elegir el almacén «Entidades de certificación raíz de confianza».
   - **Android:** Ajustes, Seguridad, «Instalar un certificado», «Certificado
     de CA». La ruta exacta cambia según la marca.
   - **iPhone y iPad:** abrir el fichero, instalar el perfil desde Ajustes y
     después activarlo en Ajustes, General, Información, «Ajustes de confianza
     de certificados».

Este paso se detallará y probará en la Fase 2, que es cuando hace falta la
cámara. Desaparece por completo al pasar a un servidor online con dominio
propio, porque entonces el certificado es público.

## 9. Día a día

Todas las órdenes se escriben en una terminal abierta en la carpeta del
proyecto (apartado 4, paso 2).

| Quieres | Orden |
| --- | --- |
| Ver si está en marcha | `docker compose ps` |
| Parar el sistema | `docker compose stop` |
| Volver a arrancarlo | `docker compose start` |
| Reiniciarlo | `docker compose restart` |
| Ver los mensajes del sistema | `docker compose logs --tail 100` |

El sistema arranca solo al abrirse Docker Desktop. Parar o reiniciar no borra
ningún dato.

**No ejecutes `docker compose down -v`.** La opción `-v` borra la base de
datos. Sin `-v`, `docker compose down` es seguro.

### Actualizar a una versión nueva

1. Haz una copia de seguridad manual (apartado 10).
2. Descarga el ZIP nuevo de GitHub y descomprímelo **encima** de la carpeta
   actual, aceptando reemplazar los ficheros. El fichero `.env` y la carpeta
   `backups` no se tocan, porque no vienen en el ZIP.
3. Ejecuta `docker compose up --build -d`.

La base de datos se actualiza sola al arrancar, sin perder datos.

## 10. Copias de seguridad

El sistema hace una copia de la base de datos cada 24 horas, de forma
automática. Si el ordenador estaba apagado, la hace al volver a encenderse.

- **Dónde están:** en la carpeta `backups` del proyecto. Cada copia es un
  fichero `sga-AAAAMMDD-HHMMSS.dump`.
- **Cuánto se conservan:** 30 días. Se cambia con `BACKUP_KEEP_DAYS` en `.env`.

**Guarda las copias en otro disco.** Una copia en el mismo disco que los datos
no protege si el disco se estropea. Cambia en `.env` la línea `BACKUP_PATH`
por una carpeta de otro disco o de la red, y aplica con `docker compose up -d`:

```
BACKUP_PATH=D:/copias-sga
```

### Hacer una copia ahora

```
docker compose exec backup sh /scripts/backup.sh
```

### Restaurar una copia

Restaurar sustituye **todos** los datos actuales por los de la copia. Antes de
hacerlo, el sistema guarda automáticamente el estado actual en un fichero
`sga-antes-de-restaurar-...dump`, por si hubiera que volver atrás.

```
docker compose stop api
docker compose exec backup sh /scripts/restore.sh /backups/sga-20261113-175305.dump
docker compose start api
```

Sustituye el nombre del fichero por el de la copia que quieras. Para ver las
disponibles, ejecuta la segunda orden sin indicar ningún fichero. El sistema
pide escribir `SI` antes de continuar.

Conviene ensayar una restauración una vez, con los datos de demostración, para
tener la seguridad de que funciona en tu ordenador.

## 11. Llevar el sistema a otro ordenador o a un servidor online

1. En el ordenador actual, haz una copia de seguridad (apartado 10) y copia a
   un pendrive el fichero `.dump` más reciente y el fichero `.env`.
2. En el equipo nuevo, sigue los apartados 2 y 3 de esta guía.
3. Copia el fichero `.env` a la carpeta del proyecto y el `.dump` a la carpeta
   `backups` (créala si no existe).
4. Arranca con `docker compose up --build -d`.
5. Restaura la copia como indica el apartado 10.

Todos los usuarios, contraseñas y registros pasan tal cual.

En un servidor online con dominio propio cambian dos líneas del `.env`:

```
SITE_ADDRESS=sga.miempresa.com
TLS_MODE=tu-correo@miempresa.com
```

Con eso el certificado es público y desaparecen los avisos del navegador. La
migración a servidor online se probará de extremo a extremo en la Fase 6.

## 12. Si algo falla

| Síntoma | Qué hacer |
| --- | --- |
| `docker` no se reconoce como orden | Docker Desktop no está instalado o hay que cerrar y abrir la terminal. |
| «Cannot connect to the Docker daemon» o parecido | Docker Desktop no está abierto. Ábrelo y espera a que arranque. |
| Error sobre el puerto 80 o 443 en uso | Otro programa usa esos puertos. Cambia en `.env` `HTTP_PORT=8080` y `HTTPS_PORT=8443`, ejecuta `docker compose up -d` y entra por `https://localhost:8443`. |
| Pide definir `POSTGRES_PASSWORD` o `ADMIN_PASSWORD` | Falta el fichero `.env` o está en otra carpeta. Repite el apartado 4. |
| La página no carga | Ejecuta `docker compose ps`. Si algún servicio no está en marcha, mira los mensajes con `docker compose logs --tail 100`. |
| «Usuario o contraseña incorrectos» con el administrador | La contraseña de `.env` solo vale la primera vez. Después vale la que elegiste. |
| El administrador ha olvidado su contraseña | Otro administrador puede restablecerla desde «Usuarios». Si no hay otro, pide ayuda. |
| Cuenta bloqueada | Espera 15 minutos o pide a un administrador que restablezca la contraseña. |

Si no se resuelve, ejecuta esto y envía el texto que aparezca:

```
docker compose ps
docker compose logs --tail 200
```

## 13. Qué está comprobado y qué no

| Elemento | Estado |
| --- | --- |
| Base de datos y reglas de integridad | Comprobado: 38 pruebas automáticas |
| Inicio de sesión, permisos, usuarios y auditoría | Comprobado: 28 pruebas automáticas |
| Web, API y proxy HTTPS funcionando juntos | Comprobado con un navegador real, en escritorio y móvil |
| Copia, restauración y arranque sobre una base nueva | Comprobado ejecutando los scripts contra PostgreSQL 16 |
| Arranque con `docker compose` en Windows | **Sin comprobar** |
| Copias automáticas dentro de Docker | **Sin comprobar** |
| Acceso desde móviles e instalación del certificado raíz | **Sin comprobar** |
