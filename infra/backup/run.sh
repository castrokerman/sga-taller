#!/bin/sh
# Servicio de copias de seguridad.
#
# Cada diez minutos comprueba si existe una copia de las últimas 24 horas y,
# si no, hace una. Así hay una copia diaria aunque el ordenador se apague por
# la noche: se hace en cuanto vuelve a encenderse.
set -u

DIR="${BACKUP_DIR:-/backups}"
INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
mkdir -p "$DIR"

echo "$(date '+%Y-%m-%d %H:%M:%S') Servicio de copias en marcha: una cada $INTERVAL_HOURS h, se conservan ${BACKUP_KEEP_DAYS:-30} días"

while true; do
  RECENT="$(find "$DIR" -maxdepth 1 -name 'sga-2*.dump' -mmin -"$((INTERVAL_HOURS * 60))" | head -n 1)"
  if [ -z "$RECENT" ]; then
    sh /scripts/backup.sh || echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: la copia de seguridad ha fallado"
  fi
  sleep 600
done
