#!/bin/bash
# Wrapper: changes to plugin dir so bun can find server.ts and deps
cd "$(dirname "$(realpath "$0")")"
exec bun server.ts
