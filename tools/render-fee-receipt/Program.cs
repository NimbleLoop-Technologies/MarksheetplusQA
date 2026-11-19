using System.Text.Json;
using MarksheetPlus.Core.Pdf;

var json = await Console.In.ReadToEndAsync();
if (string.IsNullOrWhiteSpace(json))
{
	Console.Error.WriteLine("render-fee-receipt: expected MessageJson or FeeReceipt JSON on stdin");
	return 2;
}

using var doc = JsonDocument.Parse(json);
var feeJson = doc.RootElement.TryGetProperty("FeeReceipt", out var fee) ? fee.GetRawText()
	: doc.RootElement.TryGetProperty("feeReceipt", out var feeCamel) ? feeCamel.GetRawText()
	: json;

var data = JsonSerializer.Deserialize<FeePaymentReceiptPdfData>(feeJson, new JsonSerializerOptions
{
	PropertyNameCaseInsensitive = true,
}) ?? throw new InvalidOperationException("could not deserialize FeePaymentReceiptPdfData");

// Match FeeReceiptDocuments.ResolveLogoAsync: Chromium never follows a school-supplied URL.
// Only a data: URI (already inlined) is kept; blob inlining needs the worker's storage and is omitted here.
if (data.LogoUrl is not { Length: > 0 } url || !url.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
	data = data with { LogoUrl = "" };

Console.Out.Write(FeePaymentReceiptPdfBuilder.Build(data));
return 0;
