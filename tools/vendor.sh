#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p vendor

fetch() {
  echo "-> $1"
  curl -fsSL "$2" -o "vendor/$1"
  [ -s "vendor/$1" ] || { echo "download of $1 came back empty" >&2; exit 1; }
}

fetch jszip.min.js          "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
fetch pdf-lib.min.js        "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js"
fetch pdf.min.js            "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"
fetch pdf.worker.min.js     "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js"
fetch heic2any.min.js       "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js"

echo
echo "SHA-384 (compare with the hashes jsDelivr/cdnjs publish for these versions):"
for f in vendor/*.js; do
  printf '%s  sha384-%s\n' "$f" "$(openssl dgst -sha384 -binary "$f" | openssl base64 -A)"
done