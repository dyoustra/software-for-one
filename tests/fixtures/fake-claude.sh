#!/bin/bash
# Stands in for the real `claude` binary. Echoes its args so the test can
# assert on them, and exits with whatever FAKE_EXIT says.
echo "ARGS: $*"
echo "CWD: $(pwd)"
exit "${FAKE_EXIT:-0}"
