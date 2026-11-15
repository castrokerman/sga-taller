# Pendientes

Lista de cambios pedidos y aún sin hacer, en el orden en que se pidieron.
Cuando se haga uno, se borra de aquí y pasa a las instrucciones de su fase.

## A medias: Registrar salida (rama `salidas`, sin fusionar ni copiar al PC)

Pedido el 15/11/2026. Decisiones tomadas:

- Puede salir contenido suelto o un contenedor entero con lo que lleva.
- **Salida temporal:** con destino, plazo (1 día, 1 semana, 2 semanas, 1 mes,
  3 meses u otra fecha) y aviso. Al vencer, el responsable recibe un aviso para
  indicar si ha regresado a las instalaciones de IDOM («Ha vuelto» → dónde se
  guarda; «Aún no» → nuevo plazo). Mientras está fuera, el contenedor no se
  puede tocar.
- **Salida definitiva:** con motivo; lo que sale queda de baja (contenedor
  retirado; herramientas y equipos con código, de baja; de los materiales que
  se cuentan, se descuenta lo que sale).
- **Trasladar contenedor dentro del taller**, buscándolo por código,
  descripción o contenido, y eligiendo el destino en la lista.

Hecho: migración 0023, API (salir, volver, nuevo plazo, aviso al vencer
revisado cada 10 minutos), 4 pruebas automáticas nuevas (206 en total pasan) y
la página `Departures.tsx`.

Falta: enlazar la página (tarjeta «Registrar salida» en Día a día, ruta
`salida`), los avisos de salida en «Avisos» (botones «Ha vuelto» / «Aún no»),
el estado «Fuera del taller» en la ficha del contenedor, prueba en navegador,
documentación y copia al PC.

## Fase 4

- Rol nuevo: **Responsable de compra**.
- Tarjeta nueva en Día a día: **Solicitud de compra** de material de
  laboratorio.

## Lista del 15/11/2026

1. **Almacén:** además de «Mostrar contenedores», «Mostrar ubicaciones», y
   filtrar por contenedor o ubicación también en la vista de árbol.
2. **Contenidos → Editar en tabla:** que también pueda eliminar el responsable
   de taller (hoy solo el administrador técnico).
3. **Tipos:** poder eliminar un tipo creado, no solo desactivarlo.
4. **Prestar:** además de a quién, preguntar si está asociado a un proyecto.
5. **Contenidos prestables** (una unidad): en vez de «1 ud», una nube
   «Disponible» en verde, «Prestado» en amarillo o en rojo si se ha pasado el
   plazo. Si está prestado, indicar también a qué persona y proyecto.
6. **Tipos:** poder reordenarlos a mano para verlos más cómodos.
7. **Registrar entrada / contenido:** opción para elegir proyecto y persona
   responsable. Si no se elige, es de uso genérico del taller.
8. **Registrar entrada:** al elegir un tipo de contenido, el primer nivel de
   familias son los tipos de contenido y después las familias de ese tipo;
   solo se puede elegir entre las familias del tipo elegido.
9. **Herramientas y equipos:** no pedir unidad, porque se registran de una en
   una.
10. **Registrar entrada:** lo primero, el tipo de contenido (botones); después,
    «Contenido nuevo» o «Contenido ya registrado» (reponer o aumentar).
11. **Registrar varias cosas en una misma entrada**, más rápido: en formato
    lista. Propuesta para comentar: una tabla con una fila por cosa (tipo,
    contenido existente o nuevo, cantidad, dónde se guarda, proyecto); se
    rellenan las filas, se revisan y se registran todas de una vez. Las filas
    nuevas copian el destino y el proyecto de la anterior para no repetirlos.
