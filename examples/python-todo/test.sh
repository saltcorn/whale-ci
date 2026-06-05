#!/bin/sh
# End-to-end check of the TODO API: wait for it, write a todo, read it back.
set -eu

BASE="http://web:8000"

echo "Waiting for the web service to come up..."
i=0
while [ "$i" -lt 30 ]; do
    if curl -sf "$BASE/health" >/dev/null; then
        echo "web is up"
        break
    fi
    i=$((i + 1))
    sleep 1
done

echo "Creating a todo..."
curl -sSf -X POST "$BASE/todos" \
    -H 'Content-Type: application/json' \
    -d '{"title": "write tests"}'
echo

echo "Listing todos..."
todos=$(curl -sSf "$BASE/todos")
echo "$todos"

echo "Verifying the todo was written and can be read back..."
echo "$todos" | grep -q "write tests"

echo "PASS: TODO API read/write works"
