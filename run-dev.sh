#!/bin/bash
export PATH="/Users/skylarts/Library/Application Support/fnm/node-versions/v24.18.0/installation/bin:$PATH"
cd "/Users/skylarts/Projects/forecast-v3"
exec npm run dev -- --port 3001
