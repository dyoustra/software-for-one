#!/bin/bash
# Stands in for the real `claude` binary. Echoes its args so the test can
# assert on them, emits a stream-json tail shaped like the real one so the
# runner's usage parsing is exercised, and exits with whatever FAKE_EXIT says.
echo "ARGS: $*"
echo "CWD: $(pwd)"
echo '{"type":"system","subtype":"init","session_id":"fake"}'
# Deliberate non-JSON line: the real binary interleaves these, and the parser
# must skip them rather than give up on the run's cost data.
echo "Warning: no stdin data received in 3s..."
echo '{"type":"assistant","message":{"role":"assistant"}}'
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.111,"num_turns":1,"duration_ms":3321,"usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":10106,"cache_read_input_tokens":19703}}'
exit "${FAKE_EXIT:-0}"
