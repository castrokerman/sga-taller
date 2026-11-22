# Pendientes

Lista de cambios pedidos y aún sin hacer. Cuando se haga uno, se borra de
aquí y pasa a las instrucciones de su fase.

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

Hecho: API (salir, volver, nuevo plazo, aviso al vencer revisado cada 10
minutos), 4 pruebas automáticas y la página `Departures.tsx`.

Falta: enlazar la página (tarjeta «Registrar salida» en Día a día, ruta
`salida`), los avisos de salida en «Avisos» (botones «Ha vuelto» / «Aún no»),
el estado «Fuera del taller» en la ficha del contenedor, prueba en navegador,
documentación y copia al PC. Al retomarla: su migración `0023_salidas.sql`
pasa a ser `0024` (la 0023 ya la usa la lista del 15/11) y la rama se pone al
día con `main`.

## Fase 4

- Rol nuevo: **Responsable de compra**.
- Tarjeta nueva en Día a día: **Solicitud de compra** de material de
  laboratorio.
- Pedir autorización para usar lo reservado a otro proyecto o persona.

## Notas

- Al trasladar algo reservado a otro sitio, la reserva no viaja con ello: se
  queda reducida en el origen. Revisarlo cuando se haga la Fase 4.
