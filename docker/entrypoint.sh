#!/bin/sh
# Container entrypoint.
#
# nextasks must not run as root. A data directory mounted from outside carries the rights of the host,
# and those rarely match the user inside the image by chance. So the container briefly fixes the rights
# as root and then drops to the user "nextasks". PUID and PGID say which host user owns the files.

set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# A number, and not root's: PUID=0 is a common way out of rights trouble, and would run nextasks as root.
for value in "$PUID" "$PGID"; do
    case "$value" in
        ''|*[!0-9]*)
            echo "nextasks: PUID and PGID must be numbers (got '$PUID' and '$PGID'). Nothing has been started." >&2
            exit 1
            ;;
    esac
done
if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
    echo "nextasks: PUID and PGID must not be 0: nextasks does not run as root. Use the ids of the user who owns" >&2
    echo "  your data directory ('id' on the host shows yours). Nothing has been started." >&2
    exit 1
fi

# Port inside the container, default 8000. NEXTASKS_PORT is for host networking, where the container's port
# is the server's port. Docker does not expand variables in the JSON form of CMD, hence here.
if [ "$1" = "uvicorn" ]; then
    case " $* " in
        *" --port "*) ;;
        *) set -- "$@" --port "${NEXTASKS_PORT:-8000}" ;;
    esac
fi

# Started without root already ("user:" in the compose file): nothing to fix.
if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

if [ "$(id -g nextasks)" != "$PGID" ]; then
    groupmod -o -g "$PGID" nextasks
fi
if [ "$(id -u nextasks)" != "$PUID" ]; then
    usermod -o -u "$PUID" nextasks
fi

mkdir -p /data

# Only touch it when the owner is wrong. A "chown -R" on every start costs time on large directories.
if [ "$(stat -c %u /data)" != "$PUID" ] || [ "$(stat -c %g /data)" != "$PGID" ]; then
    echo "nextasks: adjusting ownership of the data directory to $PUID:$PGID."
    chown -R "$PUID:$PGID" /data
fi

# Owner does not mean writable: on a NAS the directory can belong to the right user and still be closed by
# an access list. Then a long Python error would appear mid-start that nobody reads the cause from. So we
# really write here, as the user that does it later.
if ! gosu nextasks sh -c 'touch /data/.write-test' 2>/dev/null; then
    echo "nextasks: the data directory is not writable." >&2
    echo "" >&2
    echo "  nextasks runs as uid $PUID, gid $PGID and cannot write to the" >&2
    echo "  directory mounted at /data. Nothing has been started." >&2
    echo "" >&2
    echo "  On the host, that directory needs to belong to that user:" >&2
    echo "" >&2
    echo "      sudo chown -R $PUID:$PGID /path/to/your/data" >&2
    echo "      sudo chmod -R u+rwX /path/to/your/data" >&2
    echo "" >&2
    echo "  PUID and PGID are set in your compose file. To find your own," >&2
    echo "  run 'id' on the host and use the uid and gid it reports." >&2
    exit 1
fi
# Removed as that user too: with cap_drop ALL root lacks DAC_OVERRIDE and cannot delete in a 700 directory.
gosu nextasks rm -f /data/.write-test

exec gosu nextasks "$@"
