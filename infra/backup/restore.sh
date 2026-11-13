#!/bin/sh
# Restaura la base de datos del SGA desde una copia de seguridad.
#
# ATENCIÓN: sustituye TODOS los datos actuales por los de la copia.
# Antes de sobrescribir, guarda una copia del estado actual.
#
# Uso:
#   docker compose stop api
#   docker compose exec backup sh /scripts/restore.sh /backups/sga-AAAAMMDD-HHMMSS.dump
#   docker compose start api
#
# Añade --si al final para no pedir confirmación.
set -eu

FILE="${1:-}"
CONFIRM="${2:-}"

if [ -z "$FILE" ]; then
  echo "Indica el fichero de copia. Copias disponibles:"
  ls -1t "${BACKUP_DIR:-/backups}"/sga-*.dump 2>/dev/null || echo "  (no hay ninguna)"
  exit 1
fi
if [ ! -f "$FILE" ]; then
  echo "No existe el fichero: $FILE"
  exit 1
fi

# La copia debe poder leerse antes de tocar nada.
pg_restore --list "$FILE" > /dev/null

if [ "$CONFIRM" != "--si" ]; then
  echo "Se van a SUSTITUIR todos los datos de la base '$PGDATABASE' por los de:"
  echo "  $FILE"
  printf "Escribe SI para continuar: "
  read -r ANSWER
  if [ "$ANSWER" != "SI" ]; then
    echo "Cancelado. No se ha cambiado nada."
    exit 1
  fi
fi

# Copia del estado actual, por si la restauración no era lo que se quería.
if psql -Atc "SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'" | grep -q 1; then
  SAFETY="${BACKUP_DIR:-/backups}/sga-antes-de-restaurar-$(date +%Y%m%d-%H%M%S).dump"
  pg_dump --format=custom --no-owner --no-privileges --file="$SAFETY"
  echo "Estado actual guardado en: $SAFETY"
fi

# Todo en una transacción: o se restaura entero o no se cambia nada.
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction \
  --dbname="$PGDATABASE" "$FILE"

echo "$(date '+%Y-%m-%d %H:%M:%S') Restauración completada desde: $FILE"
