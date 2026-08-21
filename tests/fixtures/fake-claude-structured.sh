#!/bin/bash
# Stands in for the real `claude` binary under `--output-format json`.
# Args are written NUL-separated (the prompt contains newlines, so a
# line-separated dump could not be split back apart) plus the cwd, and the
# envelope on stdout is shaped like the real one: `result` is a STRING of
# JSON, not a nested object.
if [ -n "$FAKE_ARGS_FILE" ]; then
  printf '%s\0' "$@" > "$FAKE_ARGS_FILE"
  pwd > "$FAKE_ARGS_FILE.cwd"
fi
if [ -n "$FAKE_EXIT" ] && [ "$FAKE_EXIT" != "0" ]; then
  echo "Invalid API key · Please run /login" >&2
  exit "$FAKE_EXIT"
fi
echo '{"is_error":false,"total_cost_usd":0.5,"num_turns":1,"duration_ms":42,"usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4},"result":"{\"verdict\":\"ready\"}"}'
