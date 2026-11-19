#!/bin/bash
# stdin: WhatsApp MessageJson or FeeReceipt JSON; stdout: server receipt HTML (FeePaymentReceiptPdfBuilder.Build)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
MP="${QA_CI_MP_DIR:-${MPDir:-}}"
[[ -n "$MP" && -d "$MP" ]] || { echo "render-fee-receipt: set QA_CI_MP_DIR (or MPDir) to the MarksheetPlus checkout" >&2; exit 3; }
exec dotnet run --project "$DIR/render-fee-receipt.csproj" -p:MPDir="$MP" --
