#!/bin/sh
ulimit -c 0
exec node "$(dirname "$0")/evaluation.mjs" run "$@"
