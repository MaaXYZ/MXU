import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineOptions,
  convertMcpOptions,
  describeOptions,
  formatOptionValues,
  type OptionContext,
} from '../src/utils/mcpOptions.ts';
import type { OptionDefinition } from '../src/types/interface.ts';
import { piMcpLocales } from '../src/i18n/locales/piMcp.ts';

const defs: Record<string, OptionDefinition> = {
  Mode: { cases: [{ name: 'Auto' }, { name: 'Manual', option: ['Stage'] }], default_case: 'Auto' },
  Stage: {
    type: 'input',
    inputs: [{ name: 'chapter', default: '1', pipeline_type: 'int', verify: '^[1-9][0-9]*$' }],
  },
  Features: {
    type: 'checkbox',
    cases: [{ name: 'A' }, { name: 'B' }],
    default_case: [],
    max_count: 1,
  },
  Login: {
    type: 'switch',
    cases: [{ name: 'Y', option: ['Account'] }, { name: 'N' }],
    default_case: 'N',
  },
  Account: {
    type: 'input',
    inputs: [
      { name: 'user', default: '' },
      { name: 'secret', password: true, default: 'ILLEGAL-SECRET', verify: '^.+$' },
    ],
  },
  PcOnly: { controller: ['PC'], cases: [{ name: 'On' }] },
};
const roots = ['Mode', 'Features', 'Login', 'PcOnly'];
const ctx: OptionContext = {
  controllerName: 'Android',
  resourceName: 'Official',
  resolveText: (text) => text,
};
const base = () => baselineOptions(roots, defs, ctx);
const convert = (input: Record<string, unknown>, defaults = base()) =>
  convertMcpOptions({ optionKeys: roots, allOptions: defs, defaults, input, ctx });
const code = (expected: string) => (reason: unknown) =>
  !!reason &&
  typeof reason === 'object' &&
  'detail' in reason &&
  (reason.detail as { code: string }).code === expected;

test('parent and child parameters resolve from the final selection, independently of key order', () => {
  const a = convert({ Mode: 'Manual', Stage: { chapter: '4' } });
  const b = convert({ Stage: { chapter: '4' }, Mode: 'Manual' });
  assert.deepEqual(a, b);
  assert.deepEqual(a.Stage, { type: 'input', values: { chapter: '4' } });
  assert.throws(() => convert({ Stage: { chapter: '4' } }), code('invalid_option'));
  assert.throws(() => convert({ PcOnly: 'On' }), code('option_not_found'));
});
test('preset values remain strict: strings, actual case names, and distinct checkbox entries', () => {
  assert.throws(() => convert({ Mode: true }), code('invalid_option'));
  assert.throws(() => convert({ Login: true }), code('invalid_option'));
  assert.throws(() => convert({ Login: 'Yes' }), code('invalid_option'));
  assert.throws(() => convert({ Features: ['A', 'A'] }), code('invalid_option'));
  assert.throws(() => convert({ Features: ['A', 'B'] }), code('invalid_option'));
  assert.throws(() => convert({ Mode: 'Manual', Stage: { chapter: 4 } }), code('invalid_option'));
  assert.throws(() => convert({ Mode: 'Manual', Stage: { chapter: '0' } }), code('invalid_option'));
  assert.throws(() => convert({ Mode: 'Manual', Stage: { chapter: 'x' } }), code('invalid_option'));
});
test('run parameters are cloned and do not change the saved baseline', () => {
  const defaults = base();
  const copy = structuredClone(defaults);
  const result = convert({ Mode: 'Manual', Stage: { chapter: '7' } }, defaults);
  assert.deepEqual(defaults, copy);
  result.Stage = { type: 'input', values: { chapter: '9' } };
  assert.deepEqual(defaults, copy);
});
test('password marking preserves optional empty credentials, and integer input must survive JSON conversion', () => {
  const options: Record<string, OptionDefinition> = {
    Optional: { type: 'input', inputs: [{ name: 'token', password: true }] },
    Number: { type: 'input', inputs: [{ name: 'n', pipeline_type: 'int' }] },
  };
  const convert = (input: Record<string, unknown>) =>
    convertMcpOptions({
      optionKeys: ['Optional', 'Number'],
      allOptions: options,
      defaults: {},
      input,
      ctx,
    });
  assert.doesNotThrow(() => convert({}));
  assert.throws(() => convert({ Number: { n: '+12' } }), code('invalid_option'));
  assert.throws(() => convert({ Number: { n: '012' } }), code('invalid_option'));
  assert.throws(() => convert({ Number: { n: '9007199254740993' } }), code('invalid_option'));
  assert.doesNotThrow(() => convert({ Number: { n: '-12' } }));
});
test('passwords are omitted everywhere, including invalid PI defaults, and cannot be written', () => {
  const values = {
    ...base(),
    Login: { type: 'switch' as const, value: true },
    Account: { type: 'input' as const, values: { user: 'alice', secret: 'LOCAL-SECRET' } },
  };
  const description = describeOptions(roots, defs, ctx, values);
  const output = JSON.stringify(description);
  assert.ok(!output.includes('LOCAL-SECRET'));
  assert.ok(!output.includes('ILLEGAL-SECRET'));
  assert.deepEqual(formatOptionValues(roots, defs, values, ctx).Account, { user: 'alice' });
  for (const secret of ['changed', '******', '']) {
    assert.throws(
      () => convert({ Login: 'Y', Account: { secret } }, values),
      code('sensitive_option'),
    );
  }
  const result = convert({ Login: 'Y', Account: { user: 'bob' } }, values);
  assert.deepEqual(result.Account, {
    type: 'input',
    values: { user: 'bob', secret: 'LOCAL-SECRET' },
  });
  assert.throws(() => convert({ Login: 'Y' }), code('configuration_required'));
});
test('cases are always retrieved by bounded pages and do not recursively repeat child options', () => {
  const options: Record<string, OptionDefinition> = {
    Many: {
      cases: Array.from({ length: 135 }, (_, i) => ({ name: 'case-' + i, option: ['Shared'] })),
    },
    Shared: { cases: [{ name: 'loop', option: ['Many'] }] },
  };
  const values = baselineOptions(['Many'], options, ctx);
  const summary = describeOptions(['Many'], options, ctx, values);
  assert.deepEqual(Object.keys(summary.options), ['Many', 'Shared']);
  assert.equal(summary.options.Many.case_count, 135);
  assert.equal(summary.options.Many.cases, undefined);
  const pages = [0, 50, 100].map((offset) =>
    describeOptions(['Many'], options, ctx, values, 'Many', offset, 50),
  );
  const names = pages.flatMap((page) =>
    (page.options.Many.cases as { name: string }[]).map((item) => item.name),
  );
  assert.equal(new Set(names).size, 135);
  assert.equal(pages[2].nextOffset, null);
  assert.deepEqual(Object.keys(pages[0].options), ['Many']);
  assert.throws(
    () => describeOptions(['Many'], options, ctx, values, 'Unrelated'),
    code('option_not_found'),
  );
});
test('all supported locales expose the same new tools, errors, and permission controls', () => {
  const expected = [
    'capture_screen',
    'describe_task',
    'get_run_status',
    'list_instances',
    'list_tasks',
    'start_tasks',
    'stop_tasks',
  ];
  for (const locale of Object.values(piMcpLocales)) {
    assert.deepEqual(Object.keys(locale.pi.server.tools).sort(), expected);
    for (const item of Object.values(locale.pi.server.tools))
      assert.ok(item.title && item.description);
    for (const message of Object.values(locale.pi.errors)) assert.ok(message);
    for (const value of Object.values(locale.pi.server.params)) assert.ok(value);
    assert.ok(locale.pi.executionEnabled && locale.pi.screenshotEnabled);
  }
});
