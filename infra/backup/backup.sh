#!/bin/sh
# Copia de seguridad de la base de datos del SGA.
#
# Genera un fichero sga-AAAAMMDD-HHMMSS.dump en la carpeta de copias,
# comprueba que se puede leer y borra las copias antiguas.
#
# Uso manual:  docker compose exec backup sh /scripts/backup.sh
set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DIR/sga-$STAMP.dump"

mkdir -p "$DIR"

# Se escribe primero en un fichero temporal: si la copia se interrumpe,
# no queda un fichero a medias con nombre de copia válida.
pg_dump --format=custom --no-owner --no-privileges --file="$FILE.tmp"
pg_restore --list "$FILE.tmp" > /dev/null
mv "$FILE.tmp" "$FILE"

# Limpieza de copias antiguas y de temporales abandonados.
find "$DIR" -maxdepth 1 -name 'sga-*.dump' -mtime +"$KEEP_DAYS" -exec rm -f {} +
find "$DIR" -maxdepth 1 -name 'sga-*.dump.tmp' -mmin +60 -exec rm -f {} +

SIZE="$(du -h "$FILE" | cut -f1)"
echo "$(date '+%Y-%m-%d %H:%M:%S') Copia creada: $FILE ($SIZE)"
