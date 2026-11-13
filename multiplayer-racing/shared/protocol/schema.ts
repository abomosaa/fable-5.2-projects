/**
 * A tiny runtime schema validator (no dependencies) with static type
 * inference. Every message crossing the network boundary, in either
 * direction, is parsed through one of these schemas.
 *
 * Objects are strict: unknown keys are rejected, so a client cannot smuggle
 * fields such as positions or lap times into a message.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Schema<T> {
  parse(input: unknown, path: string): Result<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly isOptional: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }
>;

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(path: string, message: string): Result<T> {
  return { ok: false, error: `${path || 'message'}: ${message}` };
}

export interface StringOptions {
  min?: number;
  max: number;
  pattern?: RegExp;
  /** Applied before the length checks; the sanitised value is returned. */
  sanitize?: (value: string) => string;
}

export const s = {
  string(options: StringOptions): Schema<string> {
    const min = options.min ?? 0;
    return {
      parse(input, path) {
        if (typeof input !== 'string') return fail(path, 'expected a string');
        // Bound the work done on hostile input before sanitising.
        if (input.length > options.max * 8 + 64) return fail(path, 'string too long');
        const value = options.sanitize ? options.sanitize(input) : input;
        const length = [...value].length;
        if (length < min) return fail(path, `must be at least ${min} characters`);
        if (length > options.max) return fail(path, `must be at most ${options.max} characters`);
        if (options.pattern && !options.pattern.test(value)) return fail(path, 'has an invalid format');
        return ok(value);
      },
    };
  },

  int(min: number, max: number): Schema<number> {
    return {
      parse(input, path) {
        if (typeof input !== 'number' || !Number.isInteger(input)) return fail(path, 'expected an integer');
        if (input < min || input > max) return fail(path, `must be between ${min} and ${max}`);
        return ok(input);
      },
    };
  },

  number(min: number, max: number): Schema<number> {
    return {
      parse(input, path) {
        if (typeof input !== 'number' || !Number.isFinite(input)) return fail(path, 'expected a finite number');
        if (input < min || input > max) return fail(path, `must be between ${min} and ${max}`);
        return ok(input);
      },
    };
  },

  boolean(): Schema<boolean> {
    return {
      parse(input, path) {
        return typeof input === 'boolean' ? ok(input) : fail(path, 'expected a boolean');
      },
    };
  },

  literal<const T extends string | number | boolean>(value: T): Schema<T> {
    return {
      parse(input, path) {
        return input === value ? ok(value) : fail(path, `expected ${JSON.stringify(value)}`);
      },
    };
  },

  enumOf<const T extends string>(values: readonly T[]): Schema<T> {
    return {
      parse(input, path) {
        if (typeof input === 'string' && (values as readonly string[]).includes(input)) return ok(input as T);
        return fail(path, `expected one of ${values.join(', ')}`);
      },
    };
  },

  array<T>(item: Schema<T>, maxLength: number): Schema<T[]> {
    return {
      parse(input, path) {
        if (!Array.isArray(input)) return fail(path, 'expected an array');
        if (input.length > maxLength) return fail(path, `must have at most ${maxLength} items`);
        const out: T[] = [];
        for (let i = 0; i < input.length; i++) {
          const r = item.parse(input[i], `${path}[${i}]`);
          if (!r.ok) return r;
          out.push(r.value);
        }
        return ok(out);
      },
    };
  },

  object<S extends Shape>(shape: S): Schema<InferShape<S>> {
    const keys = Object.keys(shape);
    return {
      parse(input, path) {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          return fail(path, 'expected an object');
        }
        const source = input as Record<string, unknown>;
        for (const key of Object.keys(source)) {
          if (!Object.prototype.hasOwnProperty.call(shape, key)) {
            return fail(path ? `${path}.${key}` : key, 'unknown field');
          }
        }
        const out: Record<string, unknown> = {};
        for (const key of keys) {
          const has = Object.prototype.hasOwnProperty.call(source, key);
          const r = shape[key]!.parse(has ? source[key] : undefined, path ? `${path}.${key}` : key);
          if (!r.ok) return r;
          if (r.value !== undefined) out[key] = r.value;
        }
        return ok(out as InferShape<S>);
      },
    };
  },

  optional<T>(inner: Schema<T>): OptionalSchema<T> {
    return {
      isOptional: true,
      parse(input, path) {
        if (input === undefined) return ok(undefined);
        return inner.parse(input, path);
      },
    };
  },

  nullable<T>(inner: Schema<T>): Schema<T | null> {
    return {
      parse(input, path) {
        if (input === null) return ok(null);
        return inner.parse(input, path);
      },
    };
  },
};
