// IMP-0 (CU-z94x8eebcc): Pakistani data normalisers and header dictionary in MarksheetPlus.Core/Import.
// The library has no UI or API (AC9), so these specs drive it through tools/imp0-probe, a console app that
// references MarksheetPlus.Core from the checkout under test (QA_CI_MP_DIR) and runs one JSON case per call.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MP_DIR = process.env.QA_CI_MP_DIR ?? '';
const PROBE_DIR = path.resolve(__dirname, '../../tools/imp0-probe');
const OUT = path.join(os.tmpdir(), `imp0-probe-${process.pid}`);
const TODAY = '2026-11-22';
const MOBILE = '+923001234567';
const UTF8_HINT = 'Save as Excel (.xlsx) or CSV UTF-8 to keep Urdu names';

type Issue = { code: string; message: string; severity: 'Error' | 'Warning' | string };
type R = { value?: string | null; valid?: boolean; ambiguous?: boolean; future?: boolean; extra?: string | null; issues?: Issue[];
	phoneValidator?: boolean; authUtilsForm?: string; nameValidator?: boolean; limit?: number; field?: string | null; entity?: string | null;
	encoding?: string; codePage?: number; hadBom?: boolean; legacy?: boolean; decoded?: string; threw?: string };

let built = false;
function probe(cases: object[]): R[] {
	const out = execFileSync('dotnet', [path.join(OUT, 'Imp0Probe.dll')], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 32 << 20 });
	const res = JSON.parse(out) as R[];
	for (const [i, r] of res.entries()) expect(r.threw, `probe threw on ${JSON.stringify(cases[i])}`).toBeUndefined();
	return res;
}
const one = (c: object) => probe([c])[0];
const codes = (r: R) => (r.issues ?? []).map((i) => `${i.severity[0]}:${i.code}`);
const errors = (r: R) => (r.issues ?? []).filter((i) => i.severity === 'Error');
const b64 = (b: Buffer) => b.toString('base64');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
	test.setTimeout(5 * 60_000);
	test.skip(!MP_DIR || !fs.existsSync(path.join(MP_DIR, 'src/MarksheetPlusCode/MarksheetPlus.Core/Import')), 'QA_CI_MP_DIR has no MarksheetPlus.Core/Import (IMP-0)');
	execFileSync('dotnet', ['build', PROBE_DIR, '-c', 'Release', '--nologo', '-v', 'q', `-p:MpDir=${MP_DIR}`, '-o', OUT], { stdio: 'pipe', timeout: 5 * 60_000 });
	built = true;
});

test.afterAll(() => { if (built) fs.rmSync(OUT, { recursive: true, force: true }); });

test('AC1 Phone: every listed form normalises to the PhoneValidator / AuthUtils form', () => {
	const forms = ['0300-1234567', '0300 1234567', '03001234567', '923001234567', '+92 300 1234567', '3001234567', '  0300-1234567  ', '(0300) 1234567', '0092 300 1234567'];
	const res = probe([...forms.map((text) => ({ op: 'phone', text })), { op: 'phone', number: 3001234567 }, { op: 'phone', number: 923001234567 }]);
	for (const [i, r] of res.entries()) {
		const label = forms[i] ?? `numeric cell #${i - forms.length}`;
		expect(r.value, label).toBe(MOBILE);
		expect(r.valid, label).toBe(true);
		expect(r.phoneValidator, `${label}: PhoneValidator`).toBe(true);
		expect(r.authUtilsForm, `${label}: AuthUtils.NormalizePhoneNumber form`).toBe(r.value);
		expect(errors(r), label).toEqual([]);
	}
});

test('AC1 Phone: two numbers in one cell keep the first and return the second as extra', () => {
	for (const text of ['0300-1234567/0321-7654321', '0300 1234567, 0321 7654321']) {
		const r = one({ op: 'phone', text });
		expect(r.value, text).toBe(MOBILE);
		expect(r.extra, text).toBe('+923217654321');
		expect(r.valid, text).toBe(true);
	}
});

test('AC1 Phone: anything else is an error with a reason', () => {
	for (const text of ['abc', '042-35761234', '+1 415 555 0100', '03001234567890', '', '0300-123456']) {
		const r = one({ op: 'phone', text });
		expect(r.valid, text).toBeFalsy();
		expect(r.value ?? null, text).toBeNull();
		expect(errors(r).length, text).toBeGreaterThan(0);
		expect(errors(r)[0].message.length, `${text}: reason`).toBeGreaterThan(10);
	}
});

test('AC2 CNIC / B-Form: dashes, numeric cells, scientific notation and wrong length', () => {
	for (const text of ['35201-1234567-1', '3520112345671', '35201 1234567 1']) expect(one({ op: 'cnic', text }).value, text).toBe('35201-1234567-1');
	expect(one({ op: 'cnic', number: 3520112345671 }).value, 'numeric cell').toBe('35201-1234567-1');
	expect(one({ op: 'cnic', text: '3.52E+12', number: 3520112345671 }).value, 'numeric cell displayed as 3.52E+12').toBe('35201-1234567-1');
	for (const text of ['3.52E+12', '3.520112345671E+12']) {
		const r = one({ op: 'cnic', text });
		expect(r.valid, text).toBeFalsy();
		expect(errors(r)[0]?.message, text).toMatch(/format the column as Text and re-export/i);
	}
	for (const text of ['352011234567', '35201123456712']) {
		const r = one({ op: 'cnic', text });
		expect(r.valid, text).toBeFalsy();
		expect(codes(r), text).toContain('E:CnicLength');
	}
});

test('AC3 Dates: Excel cells, day-first text formats, ambiguity and future flags', () => {
	const cases: [object, string | null, { ambiguous?: boolean; future?: boolean; error?: boolean }][] = [
		[{ date: '2015-08-15T00:00:00', kind: 'DateOfBirth' }, '2015-08-15', {}],
		[{ number: 42231, kind: 'DateOfBirth' }, '2015-08-15', {}],
		[{ text: '15/08/2015', kind: 'DateOfBirth' }, '2015-08-15', {}],
		[{ text: '15-08-2015', kind: 'DateOfBirth' }, '2015-08-15', {}],
		[{ text: '5-Aug-15', kind: 'DateOfBirth' }, '2015-08-05', {}],
		[{ text: '2015-08-15', kind: 'DateOfBirth' }, '2015-08-15', {}],
		[{ text: '03/04/2015', kind: 'DateOfBirth' }, '2015-04-03', { ambiguous: true }],
		[{ text: '13/04/2015', kind: 'DateOfBirth' }, '2015-04-13', {}],
		[{ text: '12/12/2015', kind: 'DateOfBirth' }, '2015-12-12', {}],
		[{ text: '04/13/2015', kind: 'DateOfBirth' }, null, { error: true }],
		[{ text: '31/02/2015', kind: 'DateOfBirth' }, null, { error: true }],
		[{ text: 'hello', kind: 'DateOfBirth' }, null, { error: true }],
		[{ text: '01/01/2030', kind: 'DateOfBirth' }, '2030-01-01', { future: true }],
		[{ text: '01/01/2030', kind: 'AdmissionDate' }, '2030-01-01', { future: true }],
		[{ text: '01/01/2030', kind: 'Other' }, '2030-01-01', {}],
		[{ text: '23/11/2026', kind: 'DateOfBirth' }, '2026-11-23', { future: true }],
		[{ text: TODAY.split('-').reverse().join('/'), kind: 'DateOfBirth' }, TODAY, {}],
	];
	const res = probe(cases.map(([c]) => ({ op: 'date', today: TODAY, ...c })));
	for (const [i, r] of res.entries()) {
		const [c, value, f] = cases[i];
		const label = JSON.stringify(c);
		expect(r.value ?? null, label).toBe(value);
		expect(!!r.ambiguous, `${label}: ambiguous`).toBe(!!f.ambiguous);
		expect(!!r.future, `${label}: future`).toBe(!!f.future);
		expect(errors(r).length > 0, `${label}: error`).toBe(!!f.error);
	}
});

test('AC4 Gender: listed forms map to the enum case-insensitively; anything else is blank with a warning', () => {
	const map: Record<string, string> = { M: 'Male', F: 'Female', Male: 'Male', Female: 'Female', Boy: 'Male', Girl: 'Female', 'لڑکا': 'Male', 'لڑکی': 'Female', m: 'Male', FEMALE: 'Female', boy: 'Male', GIRL: 'Female', '  male ': 'Male' };
	for (const [text, v] of Object.entries(map)) expect(one({ op: 'gender', text }).value, text).toBe(v);
	for (const text of ['x', 'Other']) {
		const r = one({ op: 'gender', text });
		expect(r.value ?? null, text).toBeNull();
		expect(codes(r), text).toContain('W:GenderUnknown');
	}
});

test('AC5 Names: trims and collapses, keeps Urdu, warns on digits, "/", brackets and s/o / d/o', () => {
	const ok: Record<string, string> = { '  Ali   Khan  ': 'Ali Khan', 'محمد  علی': 'محمد علی', Ali: 'Ali' };
	for (const [text, v] of Object.entries(ok)) {
		const r = one({ op: 'name', text, field: 'Father name' });
		expect(r.value, text).toBe(v);
		expect(r.nameValidator, `${text}: NameValidator`).toBe(true);
	}
	const warn: Record<string, string> = { 'Ali Khan 2': 'W:NameHasDigits', 'Ali/Khan': 'W:NameHasSlash', 'Ali (Khan)': 'W:NameHasBrackets', 'Ali [Khan]': 'W:NameHasBrackets', 'Ali s/o Ahmed': 'W:NameHasRelation', 'Fatima d/o Ahmed': 'W:NameHasRelation', 'Ali S/O Ahmed': 'W:NameHasRelation' };
	for (const [text, code] of Object.entries(warn)) {
		const r = one({ op: 'name', text, field: 'Father name' });
		expect(codes(r), text).toContain(code);
		// Not a silent edit: the value is not rewritten into something that passes, and the NameValidator reason is shown.
		expect(r.valid, text).toBeFalsy();
		expect(codes(r), text).toContain('E:NameInvalid');
	}
});

test('AC6 Admission ID: upper-case, "/" and spaces to "-", the shared length limit with a reason', () => {
	const ok: Record<string, string> = { 'gr/123': 'GR-123', 'adm 45': 'ADM-45', 'AB-12': 'AB-12', ABCDEFGHIJ: 'ABCDEFGHIJ', 'a  /  b': 'A-B' };
	for (const [text, v] of Object.entries(ok)) {
		const r = one({ op: 'admission', text });
		expect(r.value, text).toBe(v);
		expect(r.limit, 'StudentFieldLimits.ADMISSION_ID_MAX_LENGTH').toBe(10);
	}
	for (const text of ['abcdefghijk', 'gr/2024/0001']) {
		const r = one({ op: 'admission', text });
		expect(r.valid, text).toBeFalsy();
		expect(errors(r)[0]?.message, text).toMatch(/10 characters or fewer/);
	}
	const blank = one({ op: 'admission', text: '' });
	expect(blank.value ?? null, 'no auto-generation').toBeNull();
	expect(codes(blank)).toContain('E:Required');
});

test('AC7 Header dictionary: the listed examples in English, Roman-Urdu and Urdu, fuzzy, and source presets as data', () => {
	const student: Record<string, string> = {
		'GR No': 'AdmissionId', 'Adm No': 'AdmissionId', 'Admission #': 'AdmissionId', 'Reg No': 'AdmissionId',
		'Father Name': 'FatherName', 'F.Name': 'FatherName', "Father's Name": 'FatherName', 'والد کا نام': 'FatherName', 'Walid ka naam': 'FatherName', '  father   NAME ': 'FatherName',
		Mobile: 'MobileNumber', Cell: 'MobileNumber', Contact: 'MobileNumber', WhatsApp: 'MobileNumber', 'Father Mobile': 'MobileNumber',
		'B-Form': 'BForm', 'Form-B': 'BForm', CRC: 'BForm',
		DOB: 'DateOfBirth', 'D.O.B.': 'DateOfBirth', 'Date of Birth': 'DateOfBirth', 'تاریخ پیدائش': 'DateOfBirth', Jins: 'Gender', 'جنس': 'Gender',
	};
	for (const [text, field] of Object.entries(student)) expect(one({ op: 'header', text, entity: 'student' }).field, text).toBe(field);
	expect(one({ op: 'header', text: 'Name', entity: 'staff' }).field).toBe('FullName');
	expect(one({ op: 'header', text: 'CNIC', entity: 'staff' }).field).toBe('Cnic');
	expect(one({ op: 'header', text: 'Father Name', entity: 'family' }).field).toBe('FatherName');
	expect(one({ op: 'header', text: 'xyz', entity: 'student' }).field ?? null).toBeNull();
	// A preset is JSON merged over the default dictionary, no code change.
	expect(one({ op: 'header', text: 'Std Reg Code', entity: 'student' }).field ?? null).toBeNull();
	const preset = JSON.stringify({ version: 1, entities: { student: { AdmissionId: ['Std Reg Code'] } } });
	expect(one({ op: 'presetMerge', json: preset, text: 'Std Reg Code', entity: 'student' }).field).toBe('AdmissionId');
	expect(fs.existsSync(path.join(MP_DIR, 'src/MarksheetPlusCode/MarksheetPlus.Core/Import')), 'dictionary lives in Core/Import').toBe(true);
});

test('AC8 CSV encoding: UTF-8 BOM, Windows-1252 fallback and the "?" in names warning', () => {
	const bom = one({ op: 'csv', base64: b64(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Name,Father\nعلی,احمد\n', 'utf8')])) });
	expect(bom).toMatchObject({ codePage: 65001, hadBom: true });
	expect(bom.decoded).toContain('علی');
	const utf8 = one({ op: 'csv', base64: b64(Buffer.from('Name,Father\nعلی,احمد\n', 'utf8')) });
	expect(utf8.codePage).toBe(65001);
	const legacy = one({ op: 'csv', base64: b64(Buffer.from('Name\nJos\xe9 M\xfcller\n', 'latin1')) });
	expect(legacy).toMatchObject({ codePage: 1252, legacy: true });
	expect(legacy.decoded).toContain('José Müller');
	for (const values of [['??? ????', 'Ali'], ['A?i']]) {
		const r = one({ op: 'csvNames', values });
		expect(r.issues?.map((i) => i.message), JSON.stringify(values)).toContain(UTF8_HINT);
	}
	expect(one({ op: 'csvNames', values: ['Ali', 'Fatima'] }).issues).toEqual([]);
});
