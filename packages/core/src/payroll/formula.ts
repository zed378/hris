import { Prisma } from '@hrms/db';

/**
 * The salary formula expression parser (PLAN/12 P5).
 *
 * The rule that cannot be compromised: **no `eval()`, no `new Function()`.**
 *
 * Salary formulas are written by a tenant's HR admin through a web interface.
 * Running them with `eval` means every tenant admin holds arbitrary code
 * execution on a server that also holds every other tenant's salary data — and
 * RLS protects nothing against code running inside the application process.
 *
 * What is built instead is a small interpreter: a tokenizer, a recursive-descent
 * parser, and an evaluator over the syntax tree. About three hundred lines, and
 * all three know only arithmetic and the function list written here.
 *
 * Three decisions carry the most weight:
 *
 *   1. **Decimal, not float.** `0.1 + 0.2` in IEEE-754 is 0.30000000000000004.
 *      In salaries that difference becomes rupiah nobody can explain, and the
 *      Phase 5 DoD demands a match down to the rupiah.
 *   2. **An unknown variable is an ERROR, not zero.** A formula
 *      `TUNJANGAN_TRANSPOR * 22` mistyped as `TUNJANGAN_TRANSPOT` would yield
 *      zero without one complaint — and that zero looks like a decision rather
 *      than a mistake.
 *   3. **Division by zero is an error.** An `Infinity` flowing into a payslip is
 *      worse than a run that stops and says the formula is wrong.
 */

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly kind: 'syntax' | 'unknown_identifier' | 'unknown_function' | 'arity' | 'math',
    /** The character position in the expression, so the mistake can be pointed at. */
    readonly position?: number,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

/** The expression length limit. The longest reasonable salary formula is far below it. */
const MAX_LENGTH = 1_000;
/** The bracket depth limit, a guard against expressions that exhaust the stack. */
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

      // Two dots in one number almost always means a mistyped thousands
      // separator — `1.000.000` instead of `1000000`. Accepting it as `NaN`
      // would propagate NaN all the way to the payslip.
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
      // Two-character operators: <=, >=, ==, !=, &&, ||
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
// The syntax tree
// -----------------------------------------------------------------------------

type Node =
  | { kind: 'number'; value: Prisma.Decimal }
  | { kind: 'variable'; name: string; position: number }
  | { kind: 'unary'; operator: '-'; operand: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node; position: number }
  | { kind: 'call'; name: string; args: Node[]; position: number };

/**
 * Operator precedence.
 *
 * A higher number binds tighter. Multiplication above addition, and comparison
 * below both — so `A + B > C` means `(A + B) > C`, which is how whoever wrote
 * it would read it.
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
      // Unary plus does nothing, but people write it.
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
      // Every operator here is left-associative, so the right-hand side is parsed
      // at one precedence level higher.
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
// The permitted functions
// -----------------------------------------------------------------------------

interface FunctionSpec {
  arity: number | 'variadic';
  apply: (args: Prisma.Decimal[]) => Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);

/**
 * The function allowlist.
 *
 * Deliberately short. Every function here has to be explainable to an HR admin
 * in one sentence, because they are the ones writing the formulas — and a
 * function that cannot be explained will be used wrongly.
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
  /** Round half up — the convention salary calculation uses. */
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
 * `if(condition, if_true, if_false)` — handled SEPARATELY, and lazily.
 *
 * It is not in `FUNCTIONS` because a function there receives arguments that are
 * already evaluated, while the entire point of `if` is the branch that is NOT
 * evaluated.
 *
 * The first version evaluated both, on the grounds that a salary formula has no
 * side effects so nothing could break. That reasoning was wrong, and its error
 * was found by an end-to-end test on the built-in formula itself:
 *
 *     if(HARI_KERJA > 0, GAJI_POKOK / HARI_KERJA * HARI_ALFA, 0)
 *
 * That formula was written precisely to guard against division by zero for an
 * employee with no attendance recap yet. With full evaluation the guard never
 * worked — the first branch was computed anyway, `HARI_KERJA` was zero, and the
 * whole run failed. Division by zero is an ERROR, not a side effect, and that
 * is what the original reasoning missed.
 *
 * Guarding against a zero divisor is the most common reason anyone writes `if`
 * in a salary formula. An `if` that cannot do it is not an `if`.
 */
const IF_ARITY = 3;

// -----------------------------------------------------------------------------
// The evaluator
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
       * `Object.hasOwn`, not `scope[name] === undefined`.
       *
       * The difference is not style. Every JavaScript object inherits members
       * from `Object.prototype` — `__proto__`, `constructor`, `toString`,
       * `valueOf`, `hasOwnProperty`. An `undefined` check lets all of them
       * through, because their value genuinely is not `undefined`: it is a
       * built-in object or function.
       *
       * The formula `__proto__ * 2` therefore passed the unknown-variable guard
       * and only failed inside the Decimal library, with a message explaining
       * nothing to the HR admin who wrote it. More importantly: the guard was
       * proven bypassable, and a guard bypassable for one name cannot be trusted
       * for another.
       */
      if (!Object.hasOwn(scope, node.name)) {
        // An ERROR, not zero. The reason is at the head of this file.
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
      // `if` is evaluated lazily: the condition first, then ONLY the chosen branch.
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
 * Evaluates a formula against a set of variables.
 *
 * Parsed on every call. Caching the syntax tree is deliberately not done yet: a
 * thousand-employee payroll run with ten components means ten thousand parses of
 * expressions a few dozen characters long, and that is unmeasurable next to one
 * database query. Adding a cache before there is evidence it is needed only adds
 * a place for stale data to hide.
 */
export function evaluateFormula(expression: string, scope: FormulaScope): Prisma.Decimal {
  return evaluate(parse(tokenize(expression)), scope);
}

/**
 * Validates a formula without evaluating it.
 *
 * Called when an HR admin saves a salary component, not when payroll runs. A bad
 * formula has to be refused on the configuration screen — finding it during a
 * run means finding it on the 25th, when a thousand payslips are due tomorrow.
 */
export interface FormulaCheck {
  ok: boolean;
  /** The variables the formula references. Used by the configuration screen to guide. */
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

/** The available functions, for display on the formula configuration screen. */
export const AVAILABLE_FUNCTIONS = [...Object.keys(FUNCTIONS), 'if'].sort();
