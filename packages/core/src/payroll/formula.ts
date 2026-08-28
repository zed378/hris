import { Prisma } from '@hrms/db';

/**
 * Parser ekspresi formula gaji (PLAN/12 F5).
 *
 * Aturan yang tidak dapat dikompromikan: **tanpa `eval()`, tanpa `new Function()`.**
 *
 * Formula gaji ditulis oleh admin HR tenant lewat antarmuka web. Menjalankannya
 * dengan `eval` berarti setiap admin tenant memegang eksekusi kode arbitrer di
 * server yang juga memegang data gaji seluruh tenant lain — dan RLS tidak
 * melindungi apa pun terhadap kode yang berjalan di dalam proses aplikasi.
 *
 * Yang dibangun karenanya adalah penerjemah kecil: tokenizer, parser turun
 * rekursif, dan evaluator atas pohon sintaks. Sekitar tiga ratus baris, dan
 * ketiganya hanya mengenal aritmetika serta daftar fungsi yang ditulis di sini.
 *
 * Tiga keputusan yang menanggung beban paling besar:
 *
 *   1. **Decimal, bukan float.** `0.1 + 0.2` dalam IEEE-754 adalah
 *      0.30000000000000004. Pada gaji, selisih itu menjadi rupiah yang tidak
 *      dapat dijelaskan, dan DoD Fase 5 menuntut kecocokan sampai satuan rupiah.
 *   2. **Variabel yang tidak dikenal adalah GALAT, bukan nol.** Formula
 *      `TUNJANGAN_TRANSPOR * 22` yang salah ketik menjadi `TUNJANGAN_TRANSPOT`
 *      akan menghasilkan nol tanpa satu pun keluhan — dan nol itu terlihat
 *      seperti keputusan, bukan seperti kesalahan.
 *   3. **Pembagian nol adalah galat.** `Infinity` yang mengalir ke slip gaji
 *      lebih buruk daripada run yang berhenti dan mengatakan formulanya salah.
 */

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly kind: 'syntax' | 'unknown_identifier' | 'unknown_function' | 'arity' | 'math',
    /** Posisi karakter dalam ekspresi, untuk menunjuk letak kesalahannya. */
    readonly position?: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** Batas panjang ekspresi. Formula gaji terpanjang yang wajar jauh di bawah ini. */
const MAX_LENGTH = 1_000;
/** Batas kedalaman tanda kurung, penjaga terhadap ekspresi yang menghabiskan stack. */
const MAX_DEPTH = 32;

// -----------------------------------------------------------------------------
// Tokenizer
// -----------------------------------------------------------------------------

type TokenType = 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'end';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const OPERATORS = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|']);

function tokenize(source: string): Token[] {
  if (source.length > MAX_LENGTH) {
    throw new FormulaError(
      `Formula terlalu panjang: ${source.length} karakter, batasnya ${MAX_LENGTH}.`,
      'syntax',
    );
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);

      // Dua titik dalam satu angka hampir selalu berarti pemisah ribuan yang
      // salah ketik — `1.000.000` alih-alih `1000000`. Menerimanya sebagai
      // `NaN` akan menyebarkan NaN sampai ke slip gaji.
      if ((text.match(/\./g) ?? []).length > 1) {
        throw new FormulaError(
          `Angka "${text}" tidak sah. Jangan pakai titik sebagai pemisah ribuan.`,
          'syntax',
          i,
        );
      }

      tokens.push({ type: 'number', value: text, position: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ type: 'identifier', value: source.slice(i, j), position: i });
      i = j;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', value: char, position: i });
      i += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', value: char, position: i });
      i += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ type: 'comma', value: char, position: i });
      i += 1;
      continue;
    }

    if (OPERATORS.has(char)) {
      // Operator dua karakter: <=, >=, ==, !=, &&, ||
      const pair = source.slice(i, i + 2);
      if (['<=', '>=', '==', '!=', '&&', '||'].includes(pair)) {
        tokens.push({ type: 'operator', value: pair, position: i });
        i += 2;
        continue;
      }
      tokens.push({ type: 'operator', value: char, position: i });
      i += 1;
      continue;
    }

    throw new FormulaError(`Karakter "${char}" tidak dikenali dalam formula.`, 'syntax', i);
  }

  tokens.push({ type: 'end', value: '', position: source.length });
  return tokens;
}

// -----------------------------------------------------------------------------
// Pohon sintaks
// -----------------------------------------------------------------------------

type Node =
  | { kind: 'number'; value: Prisma.Decimal }
  | { kind: 'variable'; name: string; position: number }
  | { kind: 'unary'; operator: '-'; operand: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node; position: number }
  | { kind: 'call'; name: string; args: Node[]; position: number };

/**
 * Presedensi operator.
 *
 * Angka lebih besar mengikat lebih erat. Perkalian di atas penjumlahan, dan
 * pembandingan di bawah keduanya — sehingga `A + B > C` berarti `(A + B) > C`,
 * yang memang bacaan wajar orang yang menulisnya.
 */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

function parse(tokens: Token[]): Node {
  let index = 0;
  let depth = 0;

  const peek = (): Token => tokens[index]!;
  const next = (): Token => tokens[index++]!;

  function parsePrimary(): Node {
    const token = next();

    if (token.type === 'number') {
      return { kind: 'number', value: new Prisma.Decimal(token.value) };
    }

    if (token.type === 'operator' && token.value === '-') {
      return { kind: 'unary', operator: '-', operand: parsePrimary() };
    }

    if (token.type === 'operator' && token.value === '+') {
      // Plus uner tidak berpengaruh, tetapi orang menulisnya.
      return parsePrimary();
    }

    if (token.type === 'lparen') {
      depth += 1;
      if (depth > MAX_DEPTH) {
        throw new FormulaError(
          `Tanda kurung bersarang terlalu dalam (batas ${MAX_DEPTH}).`,
          'syntax',
          token.position,
        );
      }
      const inner = parseExpression(0);
      const closing = next();
      if (closing.type !== 'rparen') {
        throw new FormulaError('Tanda kurung tutup tidak ditemukan.', 'syntax', closing.position);
      }
      depth -= 1;
      return inner;
    }

    if (token.type === 'identifier') {
      if (peek().type === 'lparen') {
        next(); // buang '('
        const args: Node[] = [];

        if (peek().type !== 'rparen') {
          for (;;) {
            args.push(parseExpression(0));
            if (peek().type === 'comma') {
              next();
              continue;
            }
            break;
          }
        }

        const closing = next();
        if (closing.type !== 'rparen') {
          throw new FormulaError(
            `Pemanggilan fungsi ${token.value}(…) tidak ditutup.`,
            'syntax',
            closing.position,
          );
        }
        return { kind: 'call', name: token.value, args, position: token.position };
      }

      return { kind: 'variable', name: token.value, position: token.position };
    }

    throw new FormulaError(
      token.type === 'end'
        ? 'Formula berakhir lebih awal dari yang diharapkan.'
        : `Tidak mengharapkan "${token.value}" di posisi ini.`,
      'syntax',
      token.position,
    );
  }

  function parseExpression(minPrecedence: number): Node {
    let left = parsePrimary();

    for (;;) {
      const token = peek();
      if (token.type !== 'operator') break;

      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;

      next();
      // Seluruh operator di sini asosiatif kiri, sehingga sisi kanan diurai
      // dengan presedensi satu tingkat lebih tinggi.
      const right = parseExpression(precedence + 1);
      left = { kind: 'binary', operator: token.value, left, right, position: token.position };
    }

    return left;
  }

  const tree = parseExpression(0);
  const trailing = peek();
  if (trailing.type !== 'end') {
    throw new FormulaError(
      `Ada sisa yang tidak dapat dibaca setelah formula: "${trailing.value}".`,
      'syntax',
      trailing.position,
    );
  }

  return tree;
}

// -----------------------------------------------------------------------------
// Fungsi yang diizinkan
// -----------------------------------------------------------------------------

interface FunctionSpec {
  arity: number | 'variadic';
  apply: (args: Prisma.Decimal[]) => Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);

/**
 * Daftar putih fungsi.
 *
 * Sengaja pendek. Setiap fungsi di sini harus dapat dijelaskan kepada admin HR
 * dalam satu kalimat, karena merekalah yang menulis formulanya — dan fungsi
 * yang tidak dapat dijelaskan akan dipakai salah.
 */
const FUNCTIONS: Record<string, FunctionSpec> = {
  min: {
    arity: 'variadic',
    apply: (args) => args.reduce((a, b) => (a.lessThan(b) ? a : b)),
  },
  max: {
    arity: 'variadic',
    apply: (args) => args.reduce((a, b) => (a.greaterThan(b) ? a : b)),
  },
  /** Pembulatan setengah ke atas — konvensi yang dipakai perhitungan gaji. */
  round: {
    arity: 2,
    apply: ([value, places]) =>
      value!.toDecimalPlaces(places!.toNumber(), Prisma.Decimal.ROUND_HALF_UP),
  },
  floor: {
    arity: 1,
    apply: ([value]) => value!.floor(),
  },
  ceil: {
    arity: 1,
    apply: ([value]) => value!.ceil(),
  },
  abs: {
    arity: 1,
    apply: ([value]) => value!.abs(),
  },
};

/**
 * `if(kondisi, jika_benar, jika_salah)` — ditangani TERPISAH, dan malas.
 *
 * Tidak berada di `FUNCTIONS` karena fungsi di sana menerima argumen yang sudah
 * dihitung, sedangkan seluruh guna `if` justru terletak pada cabang yang TIDAK
 * dihitung.
 *
 * Versi pertama mengevaluasi keduanya, dengan alasan bahwa formula gaji tidak
 * punya efek samping sehingga tidak ada yang rusak. Alasan itu salah, dan
 * kesalahannya ditemukan uji ujung-ke-ujung pada formula bawaan sendiri:
 *
 *     if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)
 *
 * Formula itu ditulis persis untuk menjaga terhadap pembagian nol pada karyawan
 * yang belum punya rekap presensi. Dengan evaluasi penuh, penjaganya tidak
 * pernah bekerja — cabang pertama tetap dihitung, `HARI_KERJA` bernilai nol,
 * dan seluruh run gagal. Pembagian nol adalah GALAT, bukan efek samping, dan
 * itulah yang terlewat dari pertimbangan semula.
 *
 * Menjaga terhadap pembagi nol adalah alasan paling umum orang menulis `if`
 * dalam formula gaji. Sebuah `if` yang tidak dapat melakukannya bukan `if`.
 */
const IF_ARITY = 3;

// -----------------------------------------------------------------------------
// Evaluator
// -----------------------------------------------------------------------------

export type FormulaScope = Readonly<Record<string, Prisma.Decimal | number>>;

function toDecimal(value: Prisma.Decimal | number): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function evaluate(node: Node, scope: FormulaScope): Prisma.Decimal {
  switch (node.kind) {
    case 'number':
      return node.value;

    case 'variable': {
      /**
       * `Object.hasOwn`, bukan `scope[name] === undefined`.
       *
       * Perbedaannya bukan gaya. Setiap objek JavaScript mewarisi anggota dari
       * `Object.prototype` — `__proto__`, `constructor`, `toString`, `valueOf`,
       * `hasOwnProperty`. Pemeriksaan `undefined` meloloskan seluruhnya, karena
       * nilainya memang bukan `undefined`: ia objek atau fungsi bawaan.
       *
       * Formula `__proto__ * 2` karenanya melewati penjaga variabel-tidak-dikenal
       * dan baru gagal di dalam pustaka Decimal, dengan pesan yang tidak
       * menjelaskan apa pun kepada admin HR yang menulisnya. Yang lebih penting:
       * penjaganya terbukti dapat dilewati, dan penjaga yang dapat dilewati
       * untuk satu nama tidak dapat dipercaya untuk nama lain.
       */
      if (!Object.hasOwn(scope, node.name)) {
        // GALAT, bukan nol. Lihat alasannya di kepala berkas ini.
        const known = Object.keys(scope).sort().join(', ');
        throw new FormulaError(
          `Variabel "${node.name}" tidak dikenal. Yang tersedia: ${known || '(tidak ada)'}.`,
          'unknown_identifier',
          node.position,
        );
      }
      const value = scope[node.name]!;
      if (typeof value !== 'number' && !(value instanceof Prisma.Decimal)) {
        throw new FormulaError(
          `Variabel "${node.name}" bukan angka.`,
          'unknown_identifier',
          node.position,
        );
      }
      return toDecimal(value);
    }

    case 'unary':
      return evaluate(node.operand, scope).negated();

    case 'binary': {
      const left = evaluate(node.left, scope);
      const right = evaluate(node.right, scope);
      const bool = (value: boolean): Prisma.Decimal => (value ? ONE : ZERO);

      switch (node.operator) {
        case '+':
          return left.plus(right);
        case '-':
          return left.minus(right);
        case '*':
          return left.times(right);
        case '/':
          if (right.isZero()) {
            throw new FormulaError(
              'Pembagian dengan nol. Periksa pembagi pada formula ini.',
              'math',
              node.position,
            );
          }
          return left.dividedBy(right);
        case '%':
          if (right.isZero()) {
            throw new FormulaError('Sisa bagi dengan nol.', 'math', node.position);
          }
          return left.modulo(right);
        case '<':
          return bool(left.lessThan(right));
        case '<=':
          return bool(left.lessThanOrEqualTo(right));
        case '>':
          return bool(left.greaterThan(right));
        case '>=':
          return bool(left.greaterThanOrEqualTo(right));
        case '==':
          return bool(left.equals(right));
        case '!=':
          return bool(!left.equals(right));
        case '&&':
          return bool(!left.isZero() && !right.isZero());
        case '||':
          return bool(!left.isZero() || !right.isZero());
        default:
          throw new FormulaError(`Operator "${node.operator}" tidak didukung.`, 'syntax');
      }
    }

    case 'call': {
      // `if` dievaluasi malas: kondisinya dulu, lalu HANYA cabang yang terpilih.
      if (node.name === 'if') {
        if (node.args.length !== IF_ARITY) {
          throw new FormulaError(
            `Fungsi if membutuhkan ${IF_ARITY} argumen, diberikan ${node.args.length}.`,
            'arity',
            node.position,
          );
        }
        const condition = evaluate(node.args[0]!, scope);
        return evaluate(condition.isZero() ? node.args[2]! : node.args[1]!, scope);
      }

      const spec = FUNCTIONS[node.name];
      if (!spec) {
        throw new FormulaError(
          `Fungsi "${node.name}" tidak tersedia. Yang ada: ${AVAILABLE_FUNCTIONS.join(', ')}.`,
          'unknown_function',
          node.position,
        );
      }

      if (spec.arity === 'variadic') {
        if (node.args.length === 0) {
          throw new FormulaError(
            `Fungsi ${node.name} membutuhkan sekurangnya satu argumen.`,
            'arity',
            node.position,
          );
        }
      } else if (node.args.length !== spec.arity) {
        throw new FormulaError(
          `Fungsi ${node.name} membutuhkan ${spec.arity} argumen, diberikan ${node.args.length}.`,
          'arity',
          node.position,
        );
      }

      return spec.apply(node.args.map((arg) => evaluate(arg, scope)));
    }
  }
}

/**
 * Menghitung formula terhadap sekumpulan variabel.
 *
 * Diurai setiap kali dipanggil. Optimasi cache pohon sintaks sengaja belum
 * dilakukan: satu run payroll seribu karyawan dengan sepuluh komponen berarti
 * sepuluh ribu penguraian atas ekspresi sepanjang beberapa puluh karakter, dan
 * itu tidak terukur dibanding satu query basis data. Menambahkan cache sebelum
 * ada bukti ia diperlukan hanya menambah tempat data basi dapat bersembunyi.
 */
export function evaluateFormula(expression: string, scope: FormulaScope): Prisma.Decimal {
  return evaluate(parse(tokenize(expression)), scope);
}

/**
 * Memeriksa formula tanpa menghitungnya.
 *
 * Dipanggil saat admin HR menyimpan komponen gaji, bukan saat payroll berjalan.
 * Formula yang salah harus ditolak di layar konfigurasi — menemukannya saat run
 * berarti menemukannya pada tanggal 25, ketika seribu slip harus keluar besok.
 */
export interface FormulaCheck {
  ok: boolean;
  /** Variabel yang dirujuk formula. Dipakai layar konfigurasi untuk memandu. */
  variables: string[];
  functions: string[];
  error: { message: string; position?: number | undefined } | null;
}

export function checkFormula(expression: string, availableVariables: string[]): FormulaCheck {
  const variables = new Set<string>();
  const functions = new Set<string>();

  let tree: Node;
  try {
    tree = parse(tokenize(expression));
  } catch (error) {
    return {
      ok: false,
      variables: [],
      functions: [],
      error: {
        message: error instanceof Error ? error.message : 'Formula tidak dapat dibaca.',
        position: error instanceof FormulaError ? error.position : undefined,
      },
    };
  }

  const walk = (node: Node): void => {
    switch (node.kind) {
      case 'variable':
        variables.add(node.name);
        break;
      case 'unary':
        walk(node.operand);
        break;
      case 'binary':
        walk(node.left);
        walk(node.right);
        break;
      case 'call':
        functions.add(node.name);
        node.args.forEach(walk);
        break;
      case 'number':
        break;
    }
  };
  walk(tree);

  const known = new Set(availableVariables);
  const unknownVariable = [...variables].find((name) => !known.has(name));
  if (unknownVariable) {
    return {
      ok: false,
      variables: [...variables],
      functions: [...functions],
      error: {
        message: `Variabel "${unknownVariable}" tidak tersedia. Yang dapat dipakai: ${availableVariables.sort().join(', ')}.`,
      },
    };
  }

  const unknownFunction = [...functions].find(
    (name) => name !== 'if' && !(name in FUNCTIONS),
  );
  if (unknownFunction) {
    return {
      ok: false,
      variables: [...variables],
      functions: [...functions],
      error: {
        message: `Fungsi "${unknownFunction}" tidak tersedia. Yang ada: ${AVAILABLE_FUNCTIONS.join(', ')}.`,
      },
    };
  }

  return { ok: true, variables: [...variables], functions: [...functions], error: null };
}

/** Fungsi yang tersedia, untuk ditampilkan di layar konfigurasi formula. */
export const AVAILABLE_FUNCTIONS = [...Object.keys(FUNCTIONS), 'if'].sort();
