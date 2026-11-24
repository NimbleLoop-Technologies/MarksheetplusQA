// IMP-0 probe. stdin: JSON array of cases; stdout: JSON array of results (same order).
// Case: { "op": "phone|cnic|date|gender|name|admission|header|csv|csvNames|presetMerge", "text"?, "number"?, "date"?, "kind"?, "today"?,
//         "field"?, "entity"?, "base64"?, "whole"?, "values"?, "json"? }
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FluentValidation;
using MarksheetPlus.Core.Constants;
using MarksheetPlus.Core.Import;
using MarksheetPlus.Core.UniversalValidators;

var input = JsonNode.Parse(Console.In.ReadToEnd())!.AsArray();
var output = new JsonArray();
foreach (var c in input)
{
	try { output.Add(Run(c!.AsObject())); }
	catch (Exception ex) { output.Add(new JsonObject { ["threw"] = ex.GetType().Name + ": " + ex.Message }); }
}
Console.Out.Write(output.ToJsonString(new JsonSerializerOptions { WriteIndented = false, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));

static ImportCell Cell(JsonObject c)
{
	string? text = c["text"]?.GetValue<string>();
	double? number = c["number"]?.GetValue<double>();
	DateTime? date = c["date"] is { } d ? DateTime.Parse(d.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture) : null;
	return new ImportCell(text, number, date);
}

static JsonObject Result<T>(NormalizeResult<T> r)
{
	var issues = new JsonArray();
	foreach (var i in r.Issues) issues.Add(new JsonObject { ["code"] = i.Code, ["message"] = i.Message, ["severity"] = i.Severity.ToString() });
	return new JsonObject
	{
		["value"] = r.Value is null ? null : JsonValue.Create(r.Value.ToString()),
		["valid"] = r.IsValid, ["ambiguous"] = r.IsAmbiguous, ["future"] = r.IsFuture, ["extra"] = r.Extra, ["issues"] = issues,
	};
}

static JsonObject Run(JsonObject c)
{
	var op = c["op"]!.GetValue<string>();
	switch (op)
	{
		case "phone":
		{
			var r = PhoneNormalizer.Normalize(Cell(c));
			var o = Result(r);
			o["phoneValidator"] = r.Value is not null && PhoneValidator.IsValidPhoneNumber(r.Value);
			// AuthUtils.NormalizePhoneNumber (internal in Features): "03" + 9 digits -> "+92" + rest. The import value must equal it for the local form.
			if (r.Value is { Length: 13 } v) { var local = "0" + v[3..]; o["authUtilsForm"] = local.StartsWith("03") && local.Length == 11 ? "+92" + local[1..] : local; }
			return o;
		}
		case "cnic": return Result(CnicNormalizer.Normalize(Cell(c)));
		case "date":
		{
			var kind = Enum.Parse<ImportDateKind>(c["kind"]?.GetValue<string>() ?? "Other");
			var today = DateOnly.Parse(c["today"]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture);
			var r = DateNormalizer.Normalize(Cell(c), kind, today);
			var o = Result(r);
			o["value"] = r.Value is { } dv ? dv.ToString("yyyy-MM-dd") : null;
			return o;
		}
		case "gender": return Result(GenderNormalizer.Normalize(Cell(c)));
		case "name":
		{
			var field = c["field"]?.GetValue<string>() ?? "Name";
			var r = NameNormalizer.Normalize(Cell(c), field);
			var o = Result(r);
			if (r.Value is not null)
			{
				var v = new InlineValidator<string>();
				v.RuleFor(x => x).ValidateName(field);
				o["nameValidator"] = v.Validate(r.Value).IsValid;
			}
			return o;
		}
		case "admission":
		{
			var o = Result(AdmissionIdNormalizer.Normalize(Cell(c)));
			o["limit"] = StudentFieldLimits.ADMISSION_ID_MAX_LENGTH;
			return o;
		}
		case "header":
		{
			var m = HeaderDictionary.Default.Match(c["text"]?.GetValue<string>(), c["entity"]!.GetValue<string>());
			return new JsonObject { ["field"] = m?.Field, ["entity"] = m?.Entity, ["canonical"] = HeaderDictionary.Canonicalize(c["text"]?.GetValue<string>()) };
		}
		case "presetMerge":
		{
			using var s = new MemoryStream(Encoding.UTF8.GetBytes(c["json"]!.GetValue<string>()));
			var merged = HeaderDictionary.Default.Merge(HeaderDictionary.Load(s));
			var m = merged.Match(c["text"]?.GetValue<string>(), c["entity"]!.GetValue<string>());
			return new JsonObject { ["field"] = m?.Field };
		}
		case "csv":
		{
			var bytes = Convert.FromBase64String(c["base64"]!.GetValue<string>());
			var d = CsvEncodingDetector.Detect(bytes, c["whole"]?.GetValue<bool>() ?? true);
			var issues = new JsonArray();
			foreach (var i in d.Issues) issues.Add(new JsonObject { ["code"] = i.Code, ["message"] = i.Message, ["severity"] = i.Severity.ToString() });
			return new JsonObject { ["encoding"] = d.Encoding.WebName, ["codePage"] = d.Encoding.CodePage, ["hadBom"] = d.HadBom, ["legacy"] = d.IsLegacyFallback, ["issues"] = issues, ["decoded"] = d.Encoding.GetString(bytes).TrimStart('\uFEFF') };
		}
		case "csvNames":
		{
			var values = c["values"]!.AsArray().Select(v => v?.GetValue<string>()).ToList();
			var issues = new JsonArray();
			foreach (var i in CsvEncodingDetector.CheckNameColumn(values)) issues.Add(new JsonObject { ["code"] = i.Code, ["message"] = i.Message, ["severity"] = i.Severity.ToString() });
			return new JsonObject { ["issues"] = issues };
		}
		default: throw new ArgumentException("unknown op " + op);
	}
}
