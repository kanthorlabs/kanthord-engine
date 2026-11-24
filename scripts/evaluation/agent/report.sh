#!/bin/sh
exec node "$(dirname "$0")/evaluation.mjs" report "$@"
