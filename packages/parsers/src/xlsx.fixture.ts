import { deflateRawSync } from 'node:zlib';

/**
 * A real `.xlsx` built byte by byte, for the tests.
 *
 * Not a checked-in binary. A fixture you cannot read in a diff is a fixture
 * nobody maintains, and the reader under test is precisely the thing that
 * would have to be trusted to tell you what is in it. Building the archive here
 * also means a test can say "this cell is styled as a date" and have that be a
 * statement about the file format rather than about a blob.
 */

interface Member {
  name: string;
  content: string;
}

let crcTable: Int32Array | null = null;

function crc32(buffer: Buffer): number {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] as number);
  return (crc ^ -1) >>> 0;
}

/** A ZIP archive of the given members, deflated. */
export function makeZip(members: readonly Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const raw = Buffer.from(member.content, 'utf8');
    const deflated = deflateRawSync(raw);
    const sum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

export interface FixtureCell {
  /** `s` shared string, `n` number, `d` a number styled as a date. */
  kind: 's' | 'n' | 'd';
  value: string;
}

/**
 * A one-sheet workbook. Style 1 is a date format; style 0 is General.
 */
export function makeXlsx(
  rows: readonly (readonly FixtureCell[])[],
  sheetName = 'Statement',
): Buffer {
  const shared: string[] = [];
  const indexOfString = (text: string): number => {
    const found = shared.indexOf(text);
    if (found >= 0) return found;
    shared.push(text);
    return shared.length - 1;
  };

  const escape = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const columnName = (index: number): string => {
    let name = '';
    let n = index + 1;
    while (n > 0) {
      const remainder = (n - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  };

  const body = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (cell.value === '') return '';
          if (cell.kind === 's') {
            return `<c r="${ref}" t="s"><v>${indexOfString(cell.value)}</v></c>`;
          }
          if (cell.kind === 'd') return `<c r="${ref}" s="1"><v>${cell.value}</v></c>`;
          return `<c r="${ref}"><v>${cell.value}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${body}</sheetData></worksheet>`;

  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((text) => `<si><t>${escape(text)}</t></si>`).join('') +
    `</sst>`;

  /* Two `cellXfs` entries: General, then one pointing at built-in format 14
     (`m/d/yyyy`), which is how Excel marks an ordinary date column. There is a
     `cellStyleXfs` block above it on purpose — reading the wrong one of the two
     is the classic way to decode every date as a number. */
  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>` +
    `</styleSheet>`;

  return makeZip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    },
    {
      name: 'xl/workbook.xml',
      content:
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}
