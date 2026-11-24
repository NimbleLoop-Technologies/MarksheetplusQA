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

// ── PR 573 cycle 3 (c3ae71a7): targeted groups N1–N8 on top of the AC cases above ─────────────────────────
// Every case goes through probe(), which already fails the test if a normaliser threw (N8).

test('N1 Phone: 0092 / +92 0300 / 920300 / dots / Urdu and Arabic-Indic digits / other operators all normalise', () => {
	const ok: Record<string, string> = {
		'0092-300-1234567': MOBILE, '00923001234567': MOBILE, '+92 0300 1234567': MOBILE, '+92-300-1234567': MOBILE,
		'+923001234567': MOBILE, '920300 1234567': MOBILE, '0300.1234567': MOBILE, '0300 - 123 45 67': MOBILE,
		'۰۳۰۰۱۲۳۴۵۶۷': MOBILE, '٠٣٠٠-١٢٣٤٥٦٧': MOBILE, '0345-6789012': '+923456789012', '0311 0000000': '+923110000000',
	};
	const texts = Object.keys(ok);
	const res = probe(texts.map((text) => ({ op: 'phone', text })));
	for (const [i, r] of res.entries()) {
		const t = texts[i];
		expect(r.value, t).toBe(ok[t]);
		expect(r.valid, t).toBe(true);
		expect(r.phoneValidator, `${t}: PhoneValidator`).toBe(true);
		expect(r.authUtilsForm, `${t}: AuthUtils form`).toBe(r.value);
	}
});

test('N1 + N7 + N8 Phone: too short, too long, wrong prefix, landline, blank, whitespace and very long cells are errors with a reason', () => {
	const bad: Record<string, string> = {
		'030012345': 'E:PhoneFormat', '0300-12345678': 'E:PhoneFormat', '+92 300 12345678': 'E:PhoneFormat', '+92 300 123456': 'E:PhoneFormat',
		'0092 300 123456': 'E:PhoneFormat', '+0092 300 1234567': 'E:PhoneFormat', '92 300 123456': 'E:PhoneFormat', '+3001234567': 'E:PhoneFormat',
		'042 3576 1234': 'E:PhoneNotMobile', '+92 42 35761234': 'E:PhoneNotMobile', '4235761234': 'E:PhoneNotMobile',
		'+': 'E:PhoneFormat', '()': 'E:PhoneFormat', '0300-1234567x': 'E:PhoneFormat', 'فون': 'E:PhoneFormat',
		'   ': 'E:Required', '\t\n': 'E:Required', ['9'.repeat(500)]: 'E:PhoneFormat', ['a'.repeat(10_000)]: 'E:PhoneFormat',
	};
	const texts = Object.keys(bad);
	const res = probe(texts.map((text) => ({ op: 'phone', text })));
	for (const [i, r] of res.entries()) {
		const t = texts[i].length > 40 ? `${texts[i].slice(0, 12)}…(${texts[i].length})` : JSON.stringify(texts[i]);
		expect(r.valid, t).toBeFalsy();
		expect(r.value ?? null, t).toBeNull();
		expect(codes(r), t).toContain(bad[texts[i]]);
		expect(errors(r)[0].message.length, `${t}: reason`).toBeGreaterThan(10);
	}
	expect(errors(one({ op: 'phone', text: '042 3576 1234' }))[0].message).toBe('Only mobile numbers (03xx) are accepted.');
	// A numeric cell with too few digits (Excel dropped more than the zero) is an error, not a guess.
	expect(codes(one({ op: 'phone', number: 300123456 }))).toContain('E:PhoneFormat');
});

test('N1 Phone: second and third numbers — ; newline and "or" separators, unreadable extras are kept as typed with a warning', () => {
	for (const text of ['0300-1234567; 0321-7654321', '0300-1234567\n0321-7654321', '0300-1234567 or 0321-7654321', '0300-1234567 OR 0321 7654321', '0300-1234567\\0321-7654321']) {
		const r = one({ op: 'phone', text });
		expect(r.value, JSON.stringify(text)).toBe(MOBILE);
		expect(r.extra, JSON.stringify(text)).toBe('+923217654321');
		expect(codes(r), JSON.stringify(text)).toEqual([]);
	}
	const three = one({ op: 'phone', text: '0300-1234567/0321-7654321/0333-1112223' });
	expect(three.value).toBe(MOBILE);
	expect(three.extra).toBe('+923217654321');
	expect(codes(three)).toContain('W:PhoneExtraIgnored');
	expect(three.valid).toBe(true);
	const unreadable = one({ op: 'phone', text: '0300-1234567 / ext 12' });
	expect(unreadable.value).toBe(MOBILE);
	expect(unreadable.extra).toBe('ext 12');
	expect(codes(unreadable)).toContain('W:PhoneExtraUnreadable');
	// When the FIRST number is bad the cell is an error even if the second one is fine.
	const badFirst = one({ op: 'phone', text: 'abc/0321-7654321' });
	expect(badFirst.valid).toBeFalsy();
	expect(badFirst.value ?? null).toBeNull();
});

test('N2 CNIC / B-Form: spacing, Urdu digits, numeric cells and wrong lengths', () => {
	const ok: Record<string, string> = {
		'  35201-1234567-1 ': '35201-1234567-1', '35201 - 1234567 - 1': '35201-1234567-1', '۳۵۲۰۱-۱۲۳۴۵۶۷-۱': '35201-1234567-1',
		'4210112345678': '42101-1234567-8', '61101-0000001-1': '61101-0000001-1',
	};
	for (const [text, v] of Object.entries(ok)) {
		const r = one({ op: 'cnic', text });
		expect(r.value, text).toBe(v);
		expect(r.valid, text).toBe(true);
	}
	// Numeric cells read exactly, including a leading-zero-free 13-digit value; a numeric cell wins over its display text.
	expect(one({ op: 'cnic', number: 4210112345678 }).value).toBe('42101-1234567-8');
	expect(one({ op: 'cnic', number: 4210112345678, text: '4.21E+12' }).value).toBe('42101-1234567-8');
	const bad: [object, string][] = [
		[{ text: '35201-123456-1' }, 'E:CnicLength'], [{ text: '35201-12345678-1' }, 'E:CnicLength'], [{ text: '1' }, 'E:CnicLength'],
		[{ text: '9'.repeat(300) }, 'E:CnicLength'], [{ number: 352011234567 }, 'E:CnicLength'], [{ number: 35201123456712 }, 'E:CnicLength'],
		[{ number: -3520112345671 }, 'E:CnicFormat'], [{ number: 3520112345671.5 }, 'E:CnicFormat'], [{ number: 1e20 }, 'E:CnicFormat'],
		[{ text: '35201/1234567/1' }, 'E:CnicFormat'], [{ text: 'ABCDE-1234567-1' }, 'E:CnicFormat'], [{ text: '3.52e12' }, 'E:CnicScientific'],
		[{ text: '' }, 'E:Required'], [{ text: '    ' }, 'E:Required'],
	];
	const res = probe(bad.map(([c]) => ({ op: 'cnic', ...c })));
	for (const [i, r] of res.entries()) {
		const label = JSON.stringify(bad[i][0]).slice(0, 60);
		expect(r.valid, label).toBeFalsy();
		expect(r.value ?? null, label).toBeNull();
		expect(codes(r), label).toContain(bad[i][1]);
		expect(errors(r)[0].message.length, `${label}: reason`).toBeGreaterThan(10);
	}
	expect(errors(one({ op: 'cnic', text: '35201-123456-1' }))[0].message).toBe('A CNIC/B-Form has 13 digits; this one has 12.');
});

test('N3 Names: leading, trailing, double, tab and NBSP spaces collapse; letters, case and Urdu stay exactly as typed', () => {
	const ok: Record<string, string> = {
		'  ali   KHAN ': 'ali KHAN', 'MUHAMMAD\tAli': 'MUHAMMAD Ali', 'Ayesha  Siddiqa': 'Ayesha Siddiqa', 'mcDonald': 'mcDonald',
		' محمد   علی ': 'محمد علی', 'عائشہ صدیقہ': 'عائشہ صدیقہ', "O'Brien": "O'Brien", 'Abdul-Rehman': 'Abdul-Rehman', 'M. Ali': 'M. Ali',
		'Ali​Khan': 'Ali Khan',
	};
	const texts = Object.keys(ok);
	const res = probe(texts.map((text) => ({ op: 'name', text, field: 'Student name' })));
	for (const [i, r] of res.entries()) {
		const t = JSON.stringify(texts[i]);
		expect(r.value, t).toBe(ok[texts[i]]);
		expect(r.valid, t).toBe(true);
		expect(r.nameValidator, `${t}: NameValidator`).toBe(true);
		expect(codes(r), t).toEqual([]);
	}
	// Urdu is kept code point for code point (no Arabic-letter folding, no normalisation form change).
	const urdu = 'محمد علی';
	expect([...(one({ op: 'name', text: urdu, field: 'Student name' }).value ?? '')].map((c) => c.codePointAt(0))).toEqual([...urdu].map((c) => c.codePointAt(0)));
	const arabicYeh = 'علي';
	expect(one({ op: 'name', text: arabicYeh, field: 'Student name' }).value, 'Arabic yeh is not silently changed to Farsi yeh').toBe(arabicYeh);
});

test('N3 + N7 + N8 Names: blank, whitespace-only, joiners, over 50 characters and symbols are errors with the validator reason', () => {
	const cases: [string, string, RegExp | string][] = [
		['', 'E:Required', 'Student name is required.'],
		['   \t ', 'E:Required', 'Student name is required.'],
		['​ ', 'E:Required', 'Student name is required.'],
		['A'.repeat(51), 'E:NameInvalid', 'Student name must be 50 characters or fewer.'],
		['علی'.repeat(200), 'E:NameInvalid', 'Student name must be 50 characters or fewer.'],
		['Ali@Khan', 'E:NameInvalid', 'Student name contains invalid characters.'],
		['Ali--Khan', 'E:NameInvalid', /invalid sequences/],
		['می‌را', 'E:NameHasJoiner', /invisible joiner character/],
	];
	const res = probe(cases.map(([text]) => ({ op: 'name', text, field: 'Student name' })));
	for (const [i, r] of res.entries()) {
		const [text, code, msg] = cases[i];
		const label = JSON.stringify(text.length > 30 ? `${text.slice(0, 10)}…(${text.length})` : text);
		expect(r.valid, label).toBeFalsy();
		expect(r.value ?? null, label).toBeNull();
		expect(codes(r), label).toContain(code);
		if (typeof msg === 'string') expect(errors(r)[0].message, label).toBe(msg);
		else expect(errors(r)[0].message, label).toMatch(msg);
	}
	// Exactly 50 characters is still a valid name (boundary).
	expect(one({ op: 'name', text: 'A'.repeat(50), field: 'Student name' }).valid).toBe(true);
});

test('N4 Dates: d-m-yy, dd.mm.yyyy, month names, two-digit-year century window, leap days and invalid calendar dates', () => {
	const cases: [object, string | null, { ambiguous?: boolean; future?: boolean; code?: string }][] = [
		[{ text: '5-8-15' }, '2015-08-05', { ambiguous: true }],
		[{ text: '15-8-15' }, '2015-08-15', {}],
		[{ text: '15/08/98' }, '1998-08-15', {}],
		[{ text: '15/08/26' }, '2026-08-15', {}],
		[{ text: '15/08/27' }, '1927-08-15', {}],
		[{ text: '15.08.2015' }, '2015-08-15', {}],
		[{ text: '15 Aug 2015' }, '2015-08-15', {}],
		[{ text: '15-August-2015' }, '2015-08-15', {}],
		[{ text: '15-Sept-15' }, '2015-09-15', {}],
		[{ text: '15-aug-15' }, '2015-08-15', {}],
		[{ text: '2015/08/15' }, '2015-08-15', {}],
		[{ text: '۱۵/۰۸/۲۰۱۵' }, '2015-08-15', {}],
		[{ text: '29/02/2024' }, '2024-02-29', {}],
		[{ text: '29/02/2023' }, null, { code: 'E:DateInvalid' }],
		[{ text: '31/04/2015' }, null, { code: 'E:DateInvalid' }],
		[{ text: '00/01/2015' }, null, { code: 'E:DateInvalid' }],
		[{ text: '15/13/2015' }, null, { code: 'E:DateInvalid' }],
		[{ text: '01/01/0000' }, null, { code: 'E:DateInvalid' }],
		[{ text: '2015-02-30' }, null, { code: 'E:DateInvalid' }],
		[{ text: '30-Feb-15' }, null, { code: 'E:DateInvalid' }],
		[{ text: '15-Foo-15' }, null, { code: 'E:DateFormat' }],
		[{ text: '15/08/2015 10:30' }, null, { code: 'E:DateFormat' }],
		[{ text: '42231' }, null, { code: 'E:DateFormat' }],
		[{ text: '15/08-2015' }, null, { code: 'E:DateFormat' }],
		[{ text: '' }, null, { code: 'E:Required' }],
		[{ text: '   ' }, null, { code: 'E:Required' }],
		[{ text: '1'.repeat(5_000) }, null, { code: 'E:DateFormat' }],
	];
	const res = probe(cases.map(([c]) => ({ op: 'date', today: TODAY, kind: 'DateOfBirth', ...c })));
	for (const [i, r] of res.entries()) {
		const [c, value, f] = cases[i];
		const label = JSON.stringify(c).slice(0, 60);
		expect(r.value ?? null, label).toBe(value);
		expect(!!r.ambiguous, `${label}: ambiguous`).toBe(!!f.ambiguous);
		expect(!!r.future, `${label}: future`).toBe(!!f.future);
		if (f.code) {
			expect(codes(r), label).toContain(f.code);
			expect(r.valid, label).toBeFalsy();
		} else {
			expect(errors(r), label).toEqual([]);
		}
	}
});

test('N4 Dates: Excel serials (1900 system and the fake 29 Feb 1900), out-of-range serials, date cells with a time, future DOB vs admission', () => {
	const cases: [object, string | null, { future?: boolean; code?: string }][] = [
		[{ number: 1 }, '1900-01-01', {}],
		[{ number: 59 }, '1900-02-28', {}],
		[{ number: 60 }, null, { code: 'E:DateInvalid' }],
		[{ number: 61 }, '1900-03-01', {}],
		[{ number: 42231.75 }, '2015-08-15', {}],
		[{ number: 0 }, null, { code: 'E:DateInvalid' }],
		[{ number: 0.5 }, null, { code: 'E:DateInvalid' }],
		[{ number: -1 }, null, { code: 'E:DateInvalid' }],
		[{ number: 1e10 }, null, { code: 'E:DateInvalid' }],
		[{ number: 46349 }, '2026-11-23', { future: true }],
		[{ date: '2015-08-15T23:59:59' }, '2015-08-15', {}],
		[{ date: '2026-11-23T00:00:00' }, '2026-11-23', { future: true }],
		[{ text: '23-Nov-26' }, '2026-11-23', { future: true }],
		[{ text: '01/01/2099' }, '2099-01-01', { future: true }],
	];
	const res = probe(cases.map(([c]) => ({ op: 'date', today: TODAY, kind: 'DateOfBirth', ...c })));
	for (const [i, r] of res.entries()) {
		const [c, value, f] = cases[i];
		const label = JSON.stringify(c);
		expect(r.value ?? null, label).toBe(value);
		expect(!!r.future, `${label}: future`).toBe(!!f.future);
		if (f.code) expect(codes(r), label).toContain(f.code);
		else expect(errors(r), label).toEqual([]);
		if (f.future) expect(codes(r), label).toContain('W:DateFuture');
	}
	// Future is a warning for AdmissionDate too, never for Other; a future DOB is still a valid (flagged) value.
	const adm = one({ op: 'date', today: TODAY, kind: 'AdmissionDate', text: '01/12/2026' });
	expect(adm).toMatchObject({ value: '2026-12-01', future: true, valid: true });
	expect(one({ op: 'date', today: TODAY, kind: 'Other', text: '01/12/2026' })).toMatchObject({ value: '2026-12-01', future: false });
	expect(one({ op: 'date', today: TODAY, kind: 'DateOfBirth', text: '01/12/2026' }).valid, 'future DOB is a warning, not an error').toBe(true);
});

test('N5 + N7 Gender: case variants, Roman-Urdu, Urdu and Arabic-keyboard spellings; blank is blank, unknown is blank + warning, never a throw', () => {
	const map: Record<string, string> = {
		M: 'Male', m: 'Male', MALE: 'Male', male: 'Male', mAlE: 'Male', ' M ': 'Male', F: 'Female', f: 'Female', female: 'Female', FeMaLe: 'Female',
		Larka: 'Male', ladki: 'Female',
		// Urdu, written as escapes because several Urdu letters look identical to Arabic ones:
		// mard, aurat, beta, beti (Farsi yeh U+06CC).
		'مرد': 'Male', 'عورت': 'Female', 'بیٹا': 'Male', 'بیٹی': 'Female',
		// Urdu typed on an Arabic keyboard: Arabic kaf U+0643 / Arabic yeh U+064A are folded to keheh / Farsi yeh first.
		'لڑكا': 'Male', 'لڑكي': 'Female',
	};
	const texts = Object.keys(map);
	const res = probe(texts.map((text) => ({ op: 'gender', text })));
	for (const [i, r] of res.entries()) {
		expect(r.value, texts[i]).toBe(map[texts[i]]);
		expect(codes(r), texts[i]).toEqual([]);
	}
	for (const text of ['Other', 'unknown', 'X', '1', 'Ma le', 'Mail', '?', 'لڑ', 'Z'.repeat(5_000)]) {
		const r = one({ op: 'gender', text });
		expect(r.value ?? null, text.slice(0, 20)).toBeNull();
		expect(codes(r), text.slice(0, 20)).toEqual(['W:GenderUnknown']);
		expect(r.valid, `${text.slice(0, 20)}: a warning never invalidates the row`).toBe(true);
	}
	// Blank and whitespace-only: blank value, no error, no exception. (No warning by design — see report, open question.)
	for (const text of ['', '   ', '\t']) {
		const r = one({ op: 'gender', text });
		expect(r.value ?? null, JSON.stringify(text)).toBeNull();
		expect(errors(r), JSON.stringify(text)).toEqual([]);
		expect(r.valid, JSON.stringify(text)).toBe(true);
	}
});

test('N6 (header aliases only) + N7 Admission ID: Class/Grade/Section headers map; admission blanks, Urdu digits, separators and the 10/11 boundary', () => {
	// There is no class/grade VALUE normaliser in IMP-0 (brief: N6 dropped); only the header aliases exist.
	const headers: Record<string, string> = { Class: 'ClassName', Grade: 'ClassName', 'Class Name': 'ClassName', Jamat: 'ClassName', 'جماعت': 'ClassName', Section: 'Section', Sec: 'Section', 'Roll #': 'RollNumber' };
	for (const [text, field] of Object.entries(headers)) expect(one({ op: 'header', text, entity: 'student' }).field, text).toBe(field);

	const ok: Record<string, string> = { '  gr 1  ': 'GR-1', 'gr//12': 'GR-12', '/gr-12/': 'GR-12', 'a1b2c3d4e5': 'A1B2C3D4E5', 'gr\t12': 'GR-12' };
	for (const [text, v] of Object.entries(ok)) expect(one({ op: 'admission', text }).value, JSON.stringify(text)).toBe(v);
	expect(one({ op: 'admission', number: 1234 }).value, 'numeric cell').toBe('1234');
	const bad: [string, string][] = [
		['   ', 'E:Required'], ['/', 'E:AdmissionIdCharacters'], ['GR#12', 'E:AdmissionIdCharacters'], ['۱۲۳', 'E:AdmissionIdCharacters'],
		['A'.repeat(11), 'E:AdmissionIdTooLong'], ['A'.repeat(5_000), 'E:AdmissionIdTooLong'],
	];
	const res = probe(bad.map(([text]) => ({ op: 'admission', text })));
	for (const [i, r] of res.entries()) {
		const label = JSON.stringify(bad[i][0].slice(0, 20));
		expect(r.valid, label).toBeFalsy();
		expect(r.value ?? null, label).toBeNull();
		expect(codes(r), label).toContain(bad[i][1]);
	}
});

test('N8 Header dictionary and CSV detector: blank, whitespace, symbols-only and very long input never throw', () => {
	for (const text of ['', '   ', '###', '---', 'x'.repeat(10_000), 'ـ']) {
		for (const entity of ['student', 'family', 'staff']) expect(one({ op: 'header', text, entity }).field ?? null, `${JSON.stringify(text.slice(0, 10))}/${entity}`).toBeNull();
	}
	expect(one({ op: 'csv', base64: '' })).toMatchObject({ codePage: 65001 });
	expect(one({ op: 'csvNames', values: [] }).issues).toEqual([]);
	expect(one({ op: 'csvNames', values: [null, '', '   '] }).issues).toEqual([]);
	// UTF-16 LE BOM is detected too (PR body), and a head buffer cut mid-character is not a legacy file.
	const utf16 = one({ op: 'csv', base64: b64(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\nعلی\n', 'utf16le')])) });
	expect(utf16).toMatchObject({ codePage: 1200, hadBom: true });
	const cut = Buffer.from('Name\nعلی', 'utf8').subarray(0, -1);
	expect(one({ op: 'csv', base64: b64(cut), whole: false })).toMatchObject({ codePage: 65001, legacy: false });
	expect(one({ op: 'csv', base64: b64(cut), whole: true })).toMatchObject({ codePage: 1252, legacy: true });
});
